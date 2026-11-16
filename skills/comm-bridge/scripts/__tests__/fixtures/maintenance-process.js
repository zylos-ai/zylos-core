if (process.argv[2] === '--title') process.title = process.argv[3];
process.send({ ready: true });
setInterval(() => {}, 1000);
