all:
	bun run build

# SQLite syntax from : https://github.com/mandel59/sqlite-wasm (MIT License) Credited in LICENSE
# To use another version of Sqlite, visit https://www.sqlite.org/download.html and copy the appropriate values here:
SQLITE_SOURCE := sqlite-src-3530400
SQLITE_SOURCE_ZIP_URL := https://www.sqlite.org/2026/sqlite-src-3530400.zip
SQLITE_SOURCE_ZIP_SHA3 := b834d474b9b393d85a9e3ee4cc11f1329e007e9376a424ee740796f5c4bda3a8
VECTOR_VERSION := 0.1.9
VECTOR_SOURCE := sqlite-vec-$(VECTOR_VERSION)
VECTOR_SOURCE_SHA256 := 3acd67cb4aff080c7050926fd3cf8227905fe5b7ee3829d8ee5024ab1283cf61
VECTOR_DIR := cache/$(VECTOR_SOURCE)
WASM_OPT := $(shell dirname $(shell command -v emcc))/../bin/wasm-opt

# See: https://github.com/emscripten-core/emscripten/blob/incoming/src/settings.js
EMCC_OPTS = \
	-sMALLOC=emmalloc \
	--closure 1 \
	-fno-exceptions \
	-flto \
	-sALLOW_MEMORY_GROWTH=1 \
	-sALLOW_TABLE_GROWTH=1 \
	-sDYNAMIC_EXECUTION=0 \
	-sFILESYSTEM=0 \
	-sINCOMING_MODULE_JS_API=instantiateWasm \
	-sEXPORT_NAME=init \
	-sMODULARIZE=1 \
	-sEXPORT_ES6=1 \
	-sENVIRONMENT=web,worker

# See https://www.sqlite.org/compile.html for more about the compile-time options
EMCC_SQLITE_FLAGS = \
	-DSQLITE_ENABLE_FTS5 \
	-DSQLITE_DISABLE_LFS \
	-DLONGDOUBLE_TYPE=double \
	-DSQLITE_THREADSAFE=0 \
	-DSQLITE_OS_OTHER=1 \
	-DSQLITE_DQS=0 \
	-DSQLITE_DEFAULT_MEMSTATUS=0 \
	-DSQLITE_TEMP_STORE=3 \
	-DSQLITE_MAX_EXPR_DEPTH=0 \
	-DYYSTACKDEPTH=2000 \
	-DSQLITE_USE_ALLOCA \
	-DSQLITE_UNTESTABLE \
	$(SQLITE_OMIT_FLAGS)

# These flags affect SQLite's parser and keyword table. They must be used both
# while generating the amalgamation and while compiling it with Emscripten.
SQLITE_OMIT_FLAGS = \
	-DSQLITE_OMIT_ALTERTABLE \
	-DSQLITE_OMIT_ANALYZE \
	-DSQLITE_OMIT_ATTACH \
	-DSQLITE_OMIT_AUTHORIZATION \
	-DSQLITE_OMIT_AUTOINIT \
	-DSQLITE_OMIT_AUTOVACUUM \
	-DSQLITE_OMIT_BETWEEN_OPTIMIZATION \
	-DSQLITE_OMIT_BLOB_LITERAL \
	-DSQLITE_OMIT_CASE_SENSITIVE_LIKE_PRAGMA \
	-DSQLITE_OMIT_CHECK \
	-DSQLITE_OMIT_COMPILEOPTION_DIAGS \
	-DSQLITE_OMIT_COMPLETE \
	-DSQLITE_OMIT_DECLTYPE \
	-DSQLITE_OMIT_DEPRECATED \
	-DSQLITE_OMIT_EXPLAIN \
	-DSQLITE_OMIT_FLAG_PRAGMAS \
	-DSQLITE_OMIT_FOREIGN_KEY \
	-DSQLITE_OMIT_GET_TABLE \
	-DSQLITE_OMIT_INTEGRITY_CHECK \
	-DSQLITE_OMIT_INTROSPECTION_PRAGMAS \
	-DSQLITE_OMIT_LIKE_OPTIMIZATION \
	-DSQLITE_OMIT_LOCALTIME \
	-DSQLITE_OMIT_LOOKASIDE \
	-DSQLITE_OMIT_LOAD_EXTENSION \
	-DSQLITE_OMIT_AUTORESET \
	-DSQLITE_OMIT_DATETIME_FUNCS \
	-DSQLITE_OMIT_PROGRESS_CALLBACK \
	-DSQLITE_OMIT_SCHEMA_PRAGMAS \
	-DSQLITE_OMIT_SCHEMA_VERSION_PRAGMAS \
	-DSQLITE_OMIT_SHARED_CACHE \
	-DSQLITE_OMIT_TCL_VARIABLE \
	-DSQLITE_OMIT_TEMPDB \
	-DSQLITE_OMIT_TRACE \
	-DSQLITE_OMIT_TRIGGER \
	-DSQLITE_OMIT_UTF16 \
	-DSQLITE_OMIT_VACUUM \
	-DSQLITE_OMIT_VIEW \
	-DSQLITE_OMIT_WAL \
	-DSQLITE_OMIT_WINDOWFUNC

# -DSQLITE_OMIT_XFER_OPT \
# -DSQLITE_OMIT_AUTOMATIC_INDEX \
# -DSQLITE_OMIT_EXPLAIN

# Top level build targets
build: cache/sqlite3-emscripten.js
	@$(foreach target, $^, $(call print_size, $(target)))

define print_size
	printf '=> $(1)\tsize: %s\tgzipped: %s\n' \
		$$(cat $(1) | wc -c | numfmt --to=iec) \
		$$(gzip -9 < $(1) | wc -c | numfmt --to=iec);
endef

build-dist: EMCC_OPTS += -Oz
build-dist: build

build-dist:
	cp cache/sqlite3-emscripten.js src/sqlite3-emscripten.js
	bun run build:ts
	bun x esbuild --format=esm --tree-shaking --bundle \
		--define:ENVIRONMENT_IS_WEB=false \
		--define:ENVIRONMENT_IS_WORKER=false \
		--define:ENVIRONMENT_IS_NODE=false \
		--define:WebAssembly.instantiateStreaming=false \
		--define:XMLHttpRequest=false \
		--define:import.meta.url=false \
		--minify \
		--tree-shaking \
		src/load-module.ts --outdir=dist
	bun x terser dist/load-module.js --compress passes=3 --mangle --module --output dist/load-module.min.js
	mv dist/load-module.min.js dist/load-module.js
	bun x esbuild --format=esm --minify --tree-shaking --external:./load-module.js --bundle src/init-base64.ts --outdir=dist
	bun x esbuild --format=esm --minify --tree-shaking src/init-wasm.ts --outdir=dist
	bun x esbuild --format=esm --minify --tree-shaking src/init-edge.ts --outdir=dist
	cp cache/sqlite3-emscripten.wasm dist/sqlite3-emscripten.wasm
	cp licenses/sqlite-vec-MIT.txt dist/sqlite-vec-LICENSE.txt
	bun script/embed.js

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
	Makefile \
	src/sqlite3-emscripten-pre-js.js \
	src/sqlite3-emscripten-post-js.js \
	cache/$(SQLITE_SOURCE)/sqlite3.c \
	src/sqlite3-bridge.c \
	src/exported_functions.json \
	src/exported_runtime_methods.json \
	$(VECTOR_DIR)/.extracted

cache/sqlite3-emscripten.js: $(WASM_DEPS)
	EM_CLOSURE_COMPILER=$(CURDIR)/node_modules/.bin/google-closure-compiler emcc \
		$(EMCC_OPTS) \
		$(EMCC_SQLITE_FLAGS) \
		-DSQLITE_CORE -DSQLITE_VEC_STATIC -DSQLITE_VEC_OMIT_FS -DNDEBUG \
		--pre-js $(word 2, $^) \
		--post-js $(word 3, $^) \
		$(word 4, $^) \
		$(word 5, $^) \
		$(VECTOR_DIR)/sqlite-vec.c \
		-Icache/$(SQLITE_SOURCE) \
		-I$(VECTOR_DIR) \
		-s EXPORTED_FUNCTIONS=@$(word 6, $^) \
		-s EXPORTED_RUNTIME_METHODS=@$(word 7, $^) \
		-o $(@:.wasm=.js)
	$(WASM_OPT) --enable-bulk-memory --enable-nontrapping-float-to-int -Oz --converge $(@:.js=.wasm) -o $(@:.js=.opt.wasm)
	mv $(@:.js=.opt.wasm) $(@:.js=.wasm)

################################################################################
# Building SQLite
################################################################################
cache/$(SQLITE_SOURCE)/sqlite3.c: Makefile cache/$(SQLITE_SOURCE)/.configured
	$(MAKE) -C cache/$(SQLITE_SOURCE) clean
	$(MAKE) -C cache/$(SQLITE_SOURCE) sqlite3.c OPTS='$(SQLITE_OMIT_FLAGS)'

cache/$(SQLITE_SOURCE)/.configured: cache/$(SQLITE_SOURCE)/.patched Makefile
	cd cache/$(SQLITE_SOURCE) && ./configure --disable-shared --fts5
	touch $@

cache/$(SQLITE_SOURCE)/.patched: cache/$(SQLITE_SOURCE)/.extracted script/sqlite-omit-compat.patch
	patch -d cache/$(SQLITE_SOURCE) -p1 < script/sqlite-omit-compat.patch
	touch $@

cache/$(SQLITE_SOURCE)/.extracted: cache/$(SQLITE_SOURCE).zip
	echo '$(SQLITE_SOURCE_ZIP_SHA3)  ./cache/$(SQLITE_SOURCE).zip' > cache/sha_$(SQLITE_SOURCE).txt
	sha3sum -c cache/sha_$(SQLITE_SOURCE).txt
	unzip -q -DD 'cache/$(SQLITE_SOURCE).zip' -d cache/
	touch $@

cache/$(SQLITE_SOURCE).zip: | cache
	curl -LsSf '$(SQLITE_SOURCE_ZIP_URL)' -o $@

cache:
	mkdir -p $@

# Pin and verify the released sqlite-vec amalgamation.
$(VECTOR_DIR)/.extracted: cache/$(VECTOR_SOURCE).tar.gz
	echo '$(VECTOR_SOURCE_SHA256)  $<' | sha256sum -c -
	mkdir -p $(VECTOR_DIR)
	tar -xzf $< -C $(VECTOR_DIR)
	touch $@

cache/$(VECTOR_SOURCE).tar.gz: | cache
	curl -LsSf 'https://github.com/asg017/sqlite-vec/releases/download/v$(VECTOR_VERSION)/sqlite-vec-$(VECTOR_VERSION)-amalgamation.tar.gz' -o $@

################################################################################
# Etc.
################################################################################
.PHONY: clean

clean:
	rm -rf ./cache
	rm -rf ./dist
