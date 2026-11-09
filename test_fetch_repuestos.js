const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/repuestos',
  method: 'GET',
  headers: {
    'x-admin-key': '29879071'
  }
};

const req = http.request(options, (res) => {
  console.log('STATUS:', res.statusCode);
  console.log('HEADERS:', res.headers);
  let data = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log('BODY (first 500 chars):', data.substring(0, 500));
  });
});

req.on('error', (e) => {
  console.error('problem with request:', e.message);
});

req.end();
