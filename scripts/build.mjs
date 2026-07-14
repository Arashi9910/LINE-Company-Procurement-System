import { accessSync, constants } from 'node:fs';

for (const file of ['src/server.js', 'public/index.html', 'public/app.js', 'public/catalog.js', 'public/styles.css']) {
  accessSync(file, constants.R_OK);
}

console.log('Build preflight passed');
