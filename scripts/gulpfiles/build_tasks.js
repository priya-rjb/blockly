/**
 * @license
 * Copyright 2018 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Gulp script to build Blockly for Node & NPM.
 */

var gulp = require('gulp');
gulp.replace = require('gulp-replace');
gulp.rename = require('gulp-rename');
gulp.sourcemaps = require('gulp-sourcemaps');

var path = require('path');
var fs = require('fs');
var execSync = require('child_process').execSync;
var through2 = require('through2');

const clangFormat = require('clang-format');
const clangFormatter = require('gulp-clang-format');
var closureCompiler = require('google-closure-compiler').gulp();
var closureDeps = require('google-closure-deps');
var argv = require('yargs').argv;
var rimraf = require('rimraf');

var {BUILD_DIR} = require('./config');
var {getPackageJson} = require('./helper_tasks');

////////////////////////////////////////////////////////////
//                        Build                           //
////////////////////////////////////////////////////////////

/**
 * Suffix to add to compiled output files.
 */
const COMPILED_SUFFIX = '_compressed';

/**
 * Checked-in file to cache output of closure-calculate-chunks, to
 * allow for testing on node.js v12 (or earlier) which is not
 * compatible with closure-calculate-chunks.
 */
const CHUNK_CACHE_FILE = 'scripts/gulpfiles/chunks.json'

/**
 * Name of an object to be used as a shared "global" namespace by
 * chunks generated by the Closure Compiler with the
 * --rename_prefix_namespace option (see
 * https://github.com/google/closure-compiler/wiki/Chunk-output-for-dynamic-loading#using-global_namespace-as-the-chunk-output-type
 * for more information.)  The wrapper for the first chunk will create
 * an object with this name and save it; wrappers for other chunks
 * will ensure that the same object is available with this same name.
 * The --rename_prefix_namespace option will then cause the compiled
 * chunks to create properties on this object instead of creating
 * "global" (really chunk-local) variables.  This allows later chunks
 * to depend upon modules from earlier chunks.
 *
 * It can be any value that doesn't clash with a global variable or
 * wrapper argument, but as it will appear many times in the compiled
 * output it is preferable that it be short.
 */
const NAMESPACE_OBJECT = '$';

/**
 * A list of chunks.  Order matters: later chunks can depend on
 * earlier ones, but not vice-versa.  All chunks are assumed to depend
 * on the first chunk.  Properties are as follows:
 *
 * - .name: the name of the chunk.  Used to label it when describing
 *   it to Closure Compiler and forms the prefix of filename the chunk
 *   will be written to.
 * - .entry: the source .js file which is the entrypoint for the
 *   chunk.
 * - .exports: a variable or property that will (prefixed with
 *   NAMESPACE_OBJECT) be returned from the factory function and which
 *   (sans prefix) will be set in the global scope to that returned
 *   value if the module is loaded in a browser.
 * - .importAs: the name that this chunk's exports object will be
 *   given when passed to the factory function of other chunks that
 *   depend on it.  (Needs to be distinct from .exports since (e.g.)
 *   "Blockly.blocks.all" is not a valid variable name.)
 * - .factoryPreamble: code to override the default wrapper factory
 *   function preamble.
 * - .factoryPostamble: code to override the default wrapper factory
 *   function postabmle.
 *
 * The function getChunkOptions will, after running
 * closure-calculate-chunks, update each chunk to add the following
 * properties:
 * 
 * - .dependencies: a list of the chunks the chunk depends upon.
 * - .wrapper: the chunk wrapper.
 *
 * Output files will be named <chunk.name><COMPILED_SUFFIX>.js.
 */
const chunks = [
  {
    name: 'blockly',
    entry: 'core/requires.js',
    exports: 'Blockly',
    importAs: 'Blockly',
    factoryPreamble: `const ${NAMESPACE_OBJECT}={};`,
    factoryPostamble:
        `${NAMESPACE_OBJECT}.Blockly.internal_=${NAMESPACE_OBJECT};`,
  }, {
    name: 'blocks',
    entry: 'blocks/all.js',
    exports: 'Blockly.Blocks',
    importAs: 'BlocklyBlocks',
  }, {
    name: 'javascript',
    entry: 'generators/javascript/all.js',
    exports: 'Blockly.JavaScript',
  }, {
    name: 'python',
    entry: 'generators/python/all.js',
    exports: 'Blockly.Python',
  }, {
    name: 'php',
    entry: 'generators/php/all.js',
    exports: 'Blockly.PHP',
  }, {
    name: 'lua',
    entry: 'generators/lua/all.js',
    exports: 'Blockly.Lua',
  }, {
    name: 'dart',
    entry: 'generators/dart/all.js',
    exports: 'Blockly.Dart',
  }
];

/**
 * The default factory function premable.
 */
const FACTORY_PREAMBLE = `const ${NAMESPACE_OBJECT}=Blockly.internal_;`;

/**
 * The default factory function postamble.
 */
const FACTORY_POSTAMBLE = '';

const licenseRegex = `\\/\\*\\*
 \\* @license
 \\* (Copyright \\d+ (Google LLC|Massachusetts Institute of Technology))
( \\* All rights reserved.
)? \\* SPDX-License-Identifier: Apache-2.0
 \\*\\/`;

/**
 * Helper method for stripping the Google's and MIT's Apache Licenses.
 */
function stripApacheLicense() {
  // Strip out Google's and MIT's Apache licences.
  // Closure Compiler preserves dozens of Apache licences in the Blockly code.
  // Remove these if they belong to Google or MIT.
  // MIT's permission to do this is logged in Blockly issue #2412.
  return gulp.replace(new RegExp(licenseRegex, "g"), '\n\n\n\n');
  // Replace with the same number of lines so that source-maps are not affected.
}

/**
 * Closure compiler warning groups used to treat warnings as errors.
 * For a full list of closure compiler groups, consult:
 * https://github.com/google/closure-compiler/blob/master/src/com/google/javascript/jscomp/DiagnosticGroups.java#L113
 */
var JSCOMP_ERROR = [
  'accessControls',
  'checkPrototypalTypes',
  'checkRegExp',
  'checkTypes',
  'checkVars',
  'conformanceViolations',
  'const',
  'constantProperty',
  'deprecated',
  'deprecatedAnnotations',
  'duplicateMessage',
  'es5Strict',
  'externsValidation',
  'extraRequire',
  'functionParams',
  'globalThis',
  'invalidCasts',
  'misplacedTypeAnnotation',
  // 'missingOverride',
  'missingPolyfill',
  'missingProperties',
  'missingProvide',
  'missingRequire',
  'missingReturn',
  // 'missingSourcesWarnings',
  'moduleLoad',
  'msgDescriptions',
  'nonStandardJsDocs',
  // 'polymer',
  // 'reportUnknownTypes',
  // 'strictCheckTypes',
  // 'strictMissingProperties',
  'strictModuleDepCheck',
  // 'strictPrimitiveOperators',
  'suspiciousCode',
  'typeInvalidation',
  'undefinedVars',
  'underscore',
  'unknownDefines',
  'unusedLocalVariables',
  'unusedPrivateMembers',
  'uselessCode',
  'untranspilableFeatures',
  'visibility'
];

/**
 * This task updates tests/deps.js, used by blockly_uncompressed.js
 * when loading Blockly in uncompiled mode.
 *
 * Also updates tests/deps.mocha.js, used by the mocha test suite.
 */
function buildDeps(done) {
  const closurePath = argv.closureLibrary ?
      'node_modules/google-closure-library/closure/goog' :
      'closure/goog';

  const roots = [
    closurePath,
    'core',
    'blocks',
    'generators',
  ];

  const testRoots = [
    ...roots,
    'tests/mocha'
  ];

  const args = roots.map(root => `--root '${root}' `).join('');
  execSync(`closure-make-deps ${args} > tests/deps.js`, {stdio: 'inherit'});

  // Use grep to filter out the entries that are already in deps.js.
  const testArgs = testRoots.map(root => `--root '${root}' `).join('');
  execSync(`closure-make-deps ${testArgs} | grep 'tests/mocha'` +
      ' > tests/deps.mocha.js', {stdio: 'inherit'});
  done();
};

/**
 * This task regenrates msg/json/en.js and msg/json/qqq.js from
 * msg/messages.js.
 */
function generateLangfiles(done) {
  // Run js_to_json.py
  const jsToJsonCmd = `python3 scripts/i18n/js_to_json.py \
      --input_file ${path.join('msg', 'messages.js')} \
      --output_dir ${path.join('msg', 'json')} \
      --quiet`;
  execSync(jsToJsonCmd, { stdio: 'inherit' });

  console.log(`
Regenerated several flies in msg/json/.  Now run

    git diff msg/json/*.json

and check that operation has not overwritten any modifications made to
hints, etc. by the TranslateWiki volunteers.  If it has, backport
their changes to msg/messages.js and re-run 'npm run generate:langfiles'.

Once you are satisfied that any new hints have been backported you may
go ahead and commit the changes, but note that the generate script
will have removed the translator credits - be careful not to commit
this removal!
`);

  done();
};

/**
 * This task builds Blockly's lang files.
 *     msg/*.js
 */
function buildLangfiles(done) {
  // Create output directory.
  const outputDir = path.join(BUILD_DIR, 'msg', 'js');
  fs.mkdirSync(outputDir, {recursive: true});

  // Run create_messages.py.
  let json_files = fs.readdirSync(path.join('msg', 'json'));
  json_files = json_files.filter(file => file.endsWith('json') &&
      !(new RegExp(/(keys|synonyms|qqq|constants)\.json$/).test(file)));
  json_files = json_files.map(file => path.join('msg', 'json', file));
  const createMessagesCmd = `python3 ./scripts/i18n/create_messages.py \
  --source_lang_file ${path.join('msg', 'json', 'en.json')} \
  --source_synonym_file ${path.join('msg', 'json', 'synonyms.json')} \
  --source_constants_file ${path.join('msg', 'json', 'constants.json')} \
  --key_file ${path.join('msg', 'json', 'keys.json')} \
  --output_dir ${outputDir} \
  --quiet ${json_files.join(' ')}`;
  execSync(createMessagesCmd, {stdio: 'inherit'});

  done();
};

/**
 * A helper method to return an closure compiler chunk wrapper that
 * wraps the compiler output for the given chunk in a Universal Module
 * Definition.
 */
function chunkWrapper(chunk) {
  const fileNames = chunk.dependencies.map(
      d => JSON.stringify(`./${d.name}${COMPILED_SUFFIX}.js`));
  const amdDeps = fileNames.join(', ');
  const cjsDeps = fileNames.map(f => `require(${f})`).join(', ');
  const browserDeps =
      chunk.dependencies.map(d => `root.${d.exports}`).join(', ');
  const imports = chunk.dependencies.map(d => d.importAs).join(', ');
  return `// Do not edit this file; automatically generated.

/* eslint-disable */
;(function(root, factory) {
  if (typeof define === 'function' && define.amd) { // AMD
    define([${amdDeps}], factory);
  } else if (typeof exports === 'object') { // Node.js
    module.exports = factory(${cjsDeps});
  } else { // Browser
    root.${chunk.exports} = factory(${browserDeps});
  }
}(this, function(${imports}) {
${chunk.factoryPreamble || FACTORY_PREAMBLE}
%output%
${chunk.factoryPostamble || FACTORY_POSTAMBLE}
return ${NAMESPACE_OBJECT}.${chunk.exports};
}));
`;
};

/**
 * Get chunking options to pass to Closure Compiler by using
 * closure-calculate-chunks (hereafter "ccc") to generate them based
 * on the deps.js file (which must be up to date!).
 *
 * The generated options are modified to use the original chunk names
 * given in chunks instead of the entry-point based names used by ccc.
 *
 * @return {{chunk: !Array<string>, js: !Array<string>}} The chunking
 *     information, in the same form as emitted by
 *     closure-calculate-chunks.
 *
 * TODO(cpcallen): maybeAddClosureLibrary?  Or maybe remove base.js?
 */
function getChunkOptions() {
  const cccArgs = [
    '--closure-library-base-js-path ./closure/goog/base_minimal.js',
    '--deps-file ./tests/deps.js',
    ...(chunks.map(chunk => `--entrypoint '${chunk.entry}'`)),
  ];
  const cccCommand = `closure-calculate-chunks ${cccArgs.join(' ')}`;

  // Because (as of 2021-11-25) closure-calculate-chunks v3.0.2
  // requries node.js v14 or later, we save the output of cccCommand
  // in a checked-in .json file, so we can use the contents of that
  // file when building on older versions of node.
  //
  // When this is no longer necessary the following section can be
  // replaced with:
  //
  // const rawOptions = JSON.parse(execSync(cccCommand));
  const nodeMajorVersion = /v(\d+)\./.exec(process.version)[1];
  let rawOptions;
  if (nodeMajorVersion >= 14) {
    rawOptions = JSON.parse(String(execSync(cccCommand)));
    // Replace absolute paths with relative ones, so they will be
    // valid on other machines.  Only needed because we're saving this
    // output to use later on another machine.
    rawOptions.js = rawOptions.js.map(p => p.replace(process.cwd(), '.'));
    fs.writeFileSync(CHUNK_CACHE_FILE,
                     JSON.stringify(rawOptions, null, 2) + '\n');
  } else {
    console.log(`Warning: using pre-computed chunks from ${CHUNK_CACHE_FILE}`);
    rawOptions = JSON.parse(String(fs.readFileSync(CHUNK_CACHE_FILE)));
  }

  // rawOptions should now be of the form:
  //
  // {
  //   chunk: [
  //     'requires:258',
  //     'all:10:requires',
  //     'all1:11:requires',
  //     'all2:11:requires',
  //     /* ... remaining handful of chunks */
  //   ],
  //   js: [
  //     './core/serialization/workspaces.js',
  //     './core/serialization/variables.js',
  //     /* ... remaining several hundred files */
  //   ],
  // }
  //
  // This is designed to be passed directly as-is as the options
  // object to the Closure Compiler node API, but we want to replace
  // the unhelpful entry-point based chunk names (let's call these
  // "nicknames") with the ones from chunks.  Luckily they will be in
  // the same order that the entry points were supplied in - i.e.,
  // they correspond 1:1 with the entries in chunks.
  const chunkByNickname = Object.create(null);
  let jsFiles = rawOptions.js;
  const chunkList = rawOptions.chunk.map((element, index) => {
    const [nickname, numJsFiles, dependencyNicks] = element.split(':');
    const chunk = chunks[index];

    // Replace nicknames with our names.
    chunkByNickname[nickname] = chunk;
    if (!dependencyNicks) {  // Chunk has no dependencies.
      chunk.dependencies = [];
      return `${chunk.name}:${numJsFiles}`;
    }
    chunk.dependencies =
        dependencyNicks.split(',').map(nick => chunkByNickname[nick]);
    const dependencyNames =
        chunk.dependencies.map(dependency => dependency.name).join(',');
    return `${chunk.name}:${numJsFiles}:${dependencyNames}`;
  });

  // Generate a chunk wrapper for each chunk.
  for (const chunk of chunks) {
    chunk.wrapper = chunkWrapper(chunk);
  }
  const chunkWrappers = chunks.map(chunk => `${chunk.name}:${chunk.wrapper}`);

  return {chunk: chunkList, js: rawOptions.js, chunk_wrapper: chunkWrappers};
}

/** 
 * RegExp that globally matches path.sep (i.e., "/" or "\").
 */
const pathSepRegExp = new RegExp(path.sep.replace(/\\/, '\\\\'), "g");

/** 
 * Modify the supplied gulp.rename path object to relax @package
 * restrictions in core/.
 *
 * Background: subdirectories of core/ are used to group similar files
 * together but are not intended to limit access to names
 * marked @package; instead, that annotation is intended to mean only
 * that the annotated name not part of the public API.
 *
 * To make @package behave less strictly in core/, this function can
 * be used to as a gulp.rename filter, modifying the path object to
 * flatten all files in core/** so that they're in the same directory,
 * while ensuring that files with the same base name don't conflict.
 *
 * @param {{dirname: string, basename: string, extname: string}}
 *     pathObject The path argument supplied by gulp.rename to its
 *     callback.  Modified in place.
 */
function flattenCorePaths(pathObject) {
  const dirs = pathObject.dirname.split(path.sep);
  if (dirs[0] === 'core') {
    pathObject.dirname = dirs[0];
    pathObject.basename =
        dirs.slice(1).concat(pathObject.basename).join('-slash-');
  }
}

/**
 * Undo the effects of flattenCorePaths on a single path string.
 * @param string pathString The flattened path.
 * @return string  The path after unflattening.
 */
function unflattenCorePaths(pathString) {
  return pathString.replace(/-slash-/g, path.sep);
}

/**
 * Helper method for calling the Closure compiler, establishing
 * default options (that can be overridden by the caller).
 * @param {*} options Caller-supplied options that will override the
 *     defaultOptions.
 */
function compile(options) {
  const defaultOptions = {
    compilation_level: 'SIMPLE_OPTIMIZATIONS',
    warning_level: argv.verbose ? 'VERBOSE' : 'DEFAULT',
    language_in: 'ECMASCRIPT_2020',
    language_out: 'ECMASCRIPT5_STRICT',
    rewrite_polyfills: true,
    hide_warnings_for: 'node_modules',
    define: ['COMPILED=true'],
    externs: ['./externs/svg-externs.js'],
  };
  if (argv.debug || argv.strict) {
    defaultOptions.jscomp_error = [...JSCOMP_ERROR];
    if (argv.strict) {
      defaultOptions.jscomp_error.push('strictCheckTypes');
    }
  }
  // Extra options for Closure Compiler gulp plugin.
  const platform = ['native', 'java', 'javascript'];

  return closureCompiler({...defaultOptions, ...options}, {platform});
}

/**
 * This task compiles the core library, blocks and generators, creating 
 * blockly_compressed.js, blocks_compressed.js, etc.
 *
 * The deps.js file must be up-to-date.
 */
function buildCompiled() {
  // Get chunking.
  const chunkOptions = getChunkOptions();
  // Closure Compiler options.
  const packageJson = getPackageJson();  // For version number.
  const options = {
    define: 'Blockly.VERSION="' + packageJson.version + '"',
    chunk: chunkOptions.chunk,
    chunk_wrapper: chunkOptions.chunk_wrapper,
    rename_prefix_namespace: NAMESPACE_OBJECT,
    // Don't supply the list of source files in chunkOptions.js as an
    // option to Closure Compiler; instead feed them as input via gulp.src.
  };

  // Fire up compilation pipline.
  return gulp.src(chunkOptions.js, {base: './'})
      .pipe(stripApacheLicense())
      .pipe(gulp.sourcemaps.init())
      .pipe(gulp.rename(flattenCorePaths))
      .pipe(compile(options))
      .pipe(gulp.rename({suffix: COMPILED_SUFFIX}))
      .pipe(gulp.sourcemaps.mapSources(unflattenCorePaths))
      .pipe(
          gulp.sourcemaps.write('.', {includeContent: false, sourceRoot: './'}))
      .pipe(gulp.dest(BUILD_DIR));
};

/**
 * This task builds Blockly core, blocks and generators together and uses
 * closure compiler's ADVANCED_COMPILATION mode.
 */
function buildAdvancedCompilationTest() {
  const srcs = [
    'closure/goog/base_minimal.js',
    'core/**/*.js', 'blocks/**/*.js', 'generators/**/*.js',
    'tests/compile/main.js', 'tests/compile/test_blocks.js',
  ];

  // Closure Compiler options.
  const options = {
    dependency_mode: 'PRUNE',
    compilation_level: 'ADVANCED_OPTIMIZATIONS',
    entry_point: './tests/compile/main.js',
    js_output_file: 'main_compressed.js',
  };
  return gulp.src(srcs, {base: './'})
      .pipe(stripApacheLicense())
      .pipe(gulp.sourcemaps.init())
      .pipe(gulp.rename(flattenCorePaths))
      .pipe(compile(options))
      .pipe(gulp.sourcemaps.mapSources(unflattenCorePaths))
      .pipe(gulp.sourcemaps.write(
          '.', {includeContent: false, sourceRoot: '../../'}))
      .pipe(gulp.dest('./tests/compile/'));
}

/**
 * This task builds all of Blockly:
 *     blockly_compressed.js
 *     blocks_compressed.js
 *     javascript_compressed.js
 *     python_compressed.js
 *     php_compressed.js
 *     lua_compressed.js
 *     dart_compressed.js
 *     blockly_uncompressed.js
 *     msg/json/*.js
 *     test/deps*.js
 */
const build = gulp.parallel(
    gulp.series(buildDeps, buildCompiled),
    buildLangfiles,
    );

/**
 * This task copies built files from BUILD_DIR back to the repository
 * so they can be committed to git.
 */
function checkinBuilt() {
  return gulp.src([
    `${BUILD_DIR}/**.js`,
    `${BUILD_DIR}/**.js.map`,
    `${BUILD_DIR}/**/**.js`,
    `${BUILD_DIR}/**/**.js.map`,
  ]).pipe(gulp.dest('.'));
};

/**
 * This task cleans the build directory (by deleting it).
 */
function cleanBuildDir(done) {
  // Sanity check.
  if (BUILD_DIR === '.' || BUILD_DIR === '/') {
    throw new Error(`Refusing to rm -rf ${BUILD_DIR}`);
  }
  rimraf(BUILD_DIR, done);
}

/**
 * Runs clang format on all files in the core directory.
 */
function format() {
  return gulp.src(['core/**/*.js'], {base: '.'})
      .pipe(clangFormatter.format('file', clangFormat))
      .pipe(gulp.dest('.'));
};

module.exports = {
  build: build,
  deps: buildDeps,
  generateLangfiles: generateLangfiles,
  langfiles: buildLangfiles,
  compiled: buildCompiled,
  format: format,
  checkinBuilt: checkinBuilt,
  cleanBuildDir: cleanBuildDir,
  advancedCompilationTest: buildAdvancedCompilationTest,
}
