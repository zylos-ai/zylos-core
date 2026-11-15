// A live process with PM2's truncated title and an intact initial environment.
process.title = `PM2 v7.0.1: God Daemon (${process.env.PM2_HOME.slice(0, 12)}`;
process.stdout.write('ready\n');
setInterval(() => {}, 1000);
