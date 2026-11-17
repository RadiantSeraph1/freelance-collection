// Vercel entry point. Vercel functions have no persistent disk, so this runs the
// app with an in-memory database that is re-created (and re-seeded with sample
// data) each time a function instance starts. Changes are therefore temporary.
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const { createApp } = require('../server');

module.exports = createApp();
