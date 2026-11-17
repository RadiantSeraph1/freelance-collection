// Entry point for hosts that find an Express app by file name, such as Vercel's
// zero-config Express support. It must import express and export the app itself;
// server.js only exports createApp(), which such a host cannot run.
//
// There is no persistent disk on these hosts. With a Vercel Blob store connected
// (BLOB_READ_WRITE_TOKEN set), the database is saved to the store and restored on
// start, so data survives. Without one it lives in memory and is re-seeded each time
// an instance starts. See src/persist.js for the limits.
require('express');
const { buildHandler } = require('./src/persist');

module.exports = buildHandler({ name: 'emirad', createApp: (options) => require('./server').createApp(options) });
