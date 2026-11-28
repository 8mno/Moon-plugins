// Concatenates src/*.js (in file-name order) into index.js, the single script Valenced loads.
// Usage: node build.js        (writes index.js)
//        node build.js --check (exits 1 if index.js is out of date)
var fs = require('fs'), path = require('path');
var dir = __dirname;
function bundle() {
  var files = fs.readdirSync(path.join(dir, 'src')).filter(function (f) { return /\.js$/.test(f); }).sort();
  var body = files.map(function (f) { return fs.readFileSync(path.join(dir, 'src', f), 'utf8'); }).join('');
  var version = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version;
  body = body.replace('__VERSION__', version);
  return '(function (exports) {\n  var V = valenced;\n\n' + body + '  return exports;\n})({});\n';
}
if (require.main === module) {
  var out = bundle(), file = path.join(dir, 'index.js');
  if (process.argv.indexOf('--check') >= 0) {
    if (fs.readFileSync(file, 'utf8') !== out) { console.error('index.js is out of date: run node build.js'); process.exit(1); }
    console.log('index.js is up to date');
  } else { fs.writeFileSync(file, out); console.log('wrote index.js (' + out.length + ' bytes)'); }
}
module.exports = { bundle: bundle };
