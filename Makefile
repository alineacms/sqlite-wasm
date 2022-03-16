all:
	yarn build

# SQLite syntax from : https://github.com/mandel59/sqlite-wasm (MIT License) Credited in LICENSE
# To use another version of Sqlite, visit https://www.sqlite.org/download.html and copy the appropriate values here:
SQLITE_AMALGAMATION := sqlite-amalgamation-3380100
SQLITE_AMALGAMATION_ZIP_URL := https://www.sqlite.org/2022/sqlite-amalgamation-3380100.zip
SQLITE_AMALGAMATION_ZIP_SHA3 := 907e3e7af9770156976f042f5bcbdb95f2b2857b1a65c93a37e84eb3dbdf52f3

# See: https://github.com/emscripten-core/emscripten/blob/incoming/src/settings.js
EMCC_OPTS = \
	-s ERROR_ON_UNDEFINED_SYMBOLS=0 \
	-s MALLOC="emmalloc" \
	-fno-exceptions \
	--llvm-opts 3 \
	--llvm-lto 1 \
	--memory-init-file 0 \
	-s RESERVED_FUNCTION_POINTERS=64 \
	-s NODEJS_CATCH_EXIT=0 \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s EXPORT_NAME="init" \
	-s MODULARIZE=1
	

# See https://www.sqlite.org/compile.html for more about the compile-time options
EMCC_SQLITE_FLAGS = \
	-DSQLITE_ENABLE_FTS5 \
	-DSQLITE_ENABLE_JSON1 \
	-DSQLITE_OMIT_LOAD_EXTENSION \
	-DSQLITE_DISABLE_LFS \
	-DLONGDOUBLE_TYPE=double \
	-DSQLITE_THREADSAFE=0 \
	-DSQLITE_DQS=0\
	-DSQLITE_DEFAULT_MEMSTATUS=0 \
	-DSQLITE_OMIT_DEPRECATED \
	-DSQLITE_MAX_EXPR_DEPTH=0 \
	-DSQLITE_OMIT_SHARED_CACHE \
	-DSQLITE_OMIT_PROGRESS_CALLBACK \
	-DSQLITE_OMIT_DECLTYPE \
	$(SQLITE_OWN_OPTIMIZATIONS)

SQLITE_OWN_OPTIMIZATIONS = \
	-DSQLITE_OMIT_ALTERTABLE \
	-DSQLITE_OMIT_ANALYZE \
	-DSQLITE_OMIT_AUTHORIZATION \
	-DSQLITE_OMIT_AUTOINCREMENT \
	-DSQLITE_OMIT_AUTOMATIC_INDEX \
	-DSQLITE_OMIT_AUTOVACUUM \
	-DSQLITE_OMIT_BETWEEN_OPTIMIZATION \
	-DSQLITE_OMIT_BLOB_LITERAL \
	-DSQLITE_OMIT_CASE_SENSITIVE_LIKE_PRAGMA \
	-DSQLITE_OMIT_CHECK \
	-DSQLITE_OMIT_COMPILEOPTION_DIAGS \
	-DSQLITE_OMIT_COMPLETE \
	-DSQLITE_OMIT_DECLTYPE \
	-DSQLITE_OMIT_EXPLAIN \
	-DSQLITE_OMIT_FLAG_PRAGMAS \
	-DSQLITE_OMIT_FOREIGN_KEY \
	-DSQLITE_OMIT_GET_TABLE \
	-DSQLITE_OMIT_INTEGRITY_CHECK \
	-DSQLITE_OMIT_INTROSPECTION_PRAGMAS \
	-DSQLITE_OMIT_LIKE_OPTIMIZATION \
	-DSQLITE_OMIT_LOCALTIME \
	-DSQLITE_OMIT_LOOKASIDE \
	-DSQLITE_OMIT_MEMORYDB \
	-DSQLITE_OMIT_PAGER_PRAGMAS \
	-DSQLITE_OMIT_REINDEX \
	-DSQLITE_OMIT_AUTORESET \
	-DSQLITE_OMIT_SCHEMA_PRAGMAS \
	-DSQLITE_OMIT_SCHEMA_VERSION_PRAGMAS \
	-DSQLITE_OMIT_TCL_VARIABLE \
	-DSQLITE_OMIT_TEMPDB \
	-DSQLITE_OMIT_TRACE \
	-DSQLITE_OMIT_UTF16 \
	-DSQLITE_OMIT_VACUUM \
	-DSQLITE_OMIT_VIEW \
	-DSQLITE_OMIT_WAL \
	-DSQLITE_OMIT_XFER_OPT \
	-DSQLITE_UNTESTABLE

# Top level build targets
build: dist/sqlite.wasm
	@$(foreach target, $^, $(call print_size, $(target)))

define print_size
	printf '=> $(1)\tsize: %s\tgzipped: %s\n' \
		$$(cat $(1) | wc -c | numfmt --to=iec) \
		$$(gzip -9 < $(1) | wc -c | numfmt --to=iec);
endef

# [TODO] --closure 1 optimization breaks the code
build-dist: EMCC_OPTS += -Oz
build-dist: build
build-dist:
	yarn tsc
	yarn embed

build-debug: EMCC_OPTS += -g4 -s ASSERTIONS=2 -s SAFE_HEAP=1 -s STACK_OVERFLOW_CHECK=1
##		[TODO] Fails when enabled. Fix the source in order to make it work.
## 		Assertion failed: p->iStructVersion!=0, at: sqlite-src-amalgamation-3300100/sqlite3.c,212053,fts5StructureRead
# debug: EMCC_SQLITE_FLAGS += -DSQLITE_DEBUG
build-debug: build

################################################################################
# Building WASM
################################################################################

# These are represented as $(word {line_num}, $^) in the recipe
WASM_DEPS = \
	src/sqlite3-emscripten-pre-js.js \
	src/sqlite3-emscripten-post-js.js \
	cache/$(SQLITE_AMALGAMATION)/sqlite3.c \
	src/exported_functions.json \
	src/exported_runtime_methods.json

dist/sqlite3-emscripten.cjs: dist/sqlite.wasm
dist/sqlite.wasm: $(WASM_DEPS)
	emcc \
		$(EMCC_OPTS) \
		$(EMCC_SQLITE_FLAGS) \
		--pre-js $(word 1, $^) \
		--post-js $(word 2, $^) \
		$(word 3, $^) \
		-s EXPORTED_FUNCTIONS=@$(word 4, $^) \
		-s EXTRA_EXPORTED_RUNTIME_METHODS=@$(word 5, $^) \
		-o $(@:.wasm=.js)
	mv $(@:.wasm=.js) dist/sqlite3-emscripten.cjs

################################################################################
# Building SQLite
################################################################################
cache/$(SQLITE_AMALGAMATION)/sqlite3.c: cache/$(SQLITE_AMALGAMATION).zip
	echo '$(SQLITE_AMALGAMATION_ZIP_SHA3)  ./cache/$(SQLITE_AMALGAMATION).zip' > cache/sha_$(SQLITE_AMALGAMATION).txt
	sha3sum -c cache/sha_$(SQLITE_AMALGAMATION).txt
	unzip -DD 'cache/$(SQLITE_AMALGAMATION).zip' -d cache/

cache/$(SQLITE_AMALGAMATION).zip:
	curl -LsSf '$(SQLITE_AMALGAMATION_ZIP_URL)' -o $@

################################################################################
# Etc.
################################################################################
.PHONY: clean

clean:
	rm -rf ./cache
	rm -rf ./dist

$(shell mkdir -p cache dist)