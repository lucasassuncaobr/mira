const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

function send(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, { 'Content-Type': contentType });
  res.end(body);
}

http
  .createServer((req, res) => {
    const requestPath = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
    const filePath = path.join(ROOT, requestPath);

    if (!filePath.startsWith(ROOT)) {
      send(res, 403, 'Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        send(res, 404, 'Not found');
        return;
      }

      send(res, 200, data, MIME_TYPES[path.extname(filePath)] || 'application/octet-stream');
    });
  })
  .listen(PORT, () => {
    console.log(`Mira server listening on ${PORT}`);
  });
