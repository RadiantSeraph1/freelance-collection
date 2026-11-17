// Entry point for hosts that find an Express app by file name, such as Vercel's
// zero-config Express support. It must import express and export the app itself;
// server.js only exports createApp(), which such a host cannot run.
// On these hosts there is no persistent disk, so the database lives in memory
// and is re-seeded with sample data each time an instance starts.
require('express');

process.env.DB_PATH = process.env.DB_PATH || ':memory:';

module.exports = require('./server').createApp();
