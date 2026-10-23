function ts() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

function warn(...args) {
  console.warn(`[${ts()}] [WARN]`, ...args);
}

function error(...args) {
  console.error(`[${ts()}] [ERROR]`, ...args);
}

module.exports = { log, warn, error };
