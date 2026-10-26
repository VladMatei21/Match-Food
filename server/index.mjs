import { createApp } from './app.mjs';

const { app, close } = createApp();
const port = Number(process.env.PORT || 3001);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Match-Food API listening on port ${port}`);
});
const stop = () => server.close(() => { close(); process.exit(0); });
process.on('SIGTERM',stop);
process.on('SIGINT',stop);
