all:
	yarn build

# SQLite syntax from : https://github.com/mandel59/sqlite-wasm (MIT License) Credited in LICENSE
# To use another version of Sqlite, visit https://www.sqlite.org/download.html and copy the appropriate values here:
SQLITE_AMALGAMATION := sqlite-amalgamation-3420000
SQLITE_AMALGAMATION_ZIP_URL := https://www.sqlite.org/2023/sqlite-amalgamation-3420000.zip
SQLITE_AMALGAMATION_ZIP_SHA3 := 436747dc8090d015b9869b96f5837f745e852d2ce73fd77410ed76ee51107a1f

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
	-s MODULARIZE=1 \
	-s EXPORT_ES6=1

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
	-DYYSTACKDEPTH=2000 \
	-DSQLITE_OMIT_SHARED_CACHE \
	-DSQLITE_OMIT_PROGRESS_CALLBACK \
	-DSQLITE_OMIT_DECLTYPE \
	$(SQLITE_OWN_OPTIMIZATIONS)

SQLITE_OWN_OPTIMIZATIONS = \
	-DSQLITE_OMIT_ALTERTABLE \
	-DSQLITE_OMIT_ANALYZE \
	-DSQLITE_OMIT_AUTHORIZATION \
	-DSQLITE_OMIT_AUTOINCREMENT \
	-DSQLITE_OMIT_AUTOVACUUM \
	-DSQLITE_OMIT_BETWEEN_OPTIMIZATION \
	-DSQLITE_OMIT_BLOB_LITERAL \
	-DSQLITE_OMIT_CASE_SENSITIVE_LIKE_PRAGMA \
	-DSQLITE_OMIT_CHECK \
	-DSQLITE_OMIT_COMPILEOPTION_DIAGS \
	-DSQLITE_OMIT_COMPLETE \
	-DSQLITE_OMIT_DECLTYPE \
	-DSQLITE_OMIT_FLAG_PRAGMAS \
	-DSQLITE_OMIT_FOREIGN_KEY \
	-DSQLITE_OMIT_GET_TABLE \
	-DSQLITE_OMIT_INTEGRITY_CHECK \
	-DSQLITE_OMIT_INTROSPECTION_PRAGMAS \
	-DSQLITE_OMIT_LIKE_OPTIMIZATION \
	-DSQLITE_OMIT_LOCALTIME \
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
	-DSQLITE_UNTESTABLE

# -DSQLITE_OMIT_XFER_OPT \
# -DSQLITE_OMIT_AUTOMATIC_INDEX \
# -DSQLITE_OMIT_LOOKASIDE \
# -DSQLITE_OMIT_EXPLAIN

# Top level build targets
build: cache/sqlite3-emscripten.js
	@$(foreach target, $^, $(call print_size, $(target)))

define print_size
	printf '=> $(1)\tsize: %s\tgzipped: %s\n' \
		$$(cat $(1) | wc -c | numfmt --to=iec) \
		$$(gzip -9 < $(1) | wc -c | numfmt --to=iec);
endef

build-dist: EMCC_OPTS += -Oz -g1
build-dist: build

build-dist:
	node script/process.js
	yarn build:ts
	esbuild --format=esm --tree-shaking --external:@alinea/iso --bundle \
		--define:ENVIRONMENT_IS_WEB=false \
		--define:ENVIRONMENT_IS_WORKER=false \
		--define:ENVIRONMENT_IS_NODE=false \
		--define:WebAssembly.instantiateStreaming=false \
		--define:XMLHttpRequest=false \
		--define:import.meta.url=false \
		--minify \
		--tree-shaking \
		src/load-module.ts --outdir=dist
	esbuild --format=esm --tree-shaking --external:./load-module.js --bundle src/init-base64.ts --outdir=dist
	esbuild --format=esm --tree-shaking src/init-wasm.ts --outdir=dist
	cp cache/sqlite3-emscripten.wasm dist/sqlite3-emscripten.wasm
	node script/embed.js

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

cache/sqlite3-emscripten.js: $(WASM_DEPS)
	emcc \
		$(EMCC_OPTS) \
		$(EMCC_SQLITE_FLAGS) \
		--pre-js $(word 1, $^) \
		--post-js $(word 2, $^) \
		$(word 3, $^) \
		-s EXPORTED_FUNCTIONS=@$(word 4, $^) \
		-s EXPORTED_RUNTIME_METHODS=@$(word 5, $^) \
		-o $(@:.wasm=.js)

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
	rm -rf ./cache

$(shell mkdir -p cache)