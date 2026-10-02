const fs = require('fs');
const p = process.cwd();
console.log('CWD:', p);
const nm = fs.existsSync(p + '/node_modules');
console.log('node_modules exists:', nm);
if (nm) {
  const items = fs.readdirSync(p + '/node_modules');
  console.log('count:', items.length);
  console.log('first:', items.slice(0, 5));
}
console.log('pkg exists:', fs.existsSync(p + '/package.json'));
