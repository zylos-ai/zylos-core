// A disposable process with a caller-selected command-line title; no command runs.
process.title = process.argv[2];
process.send({ ready: true, title: process.title });
setInterval(() => {}, 1000);
