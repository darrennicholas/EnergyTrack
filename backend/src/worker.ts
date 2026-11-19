process.env.WORKER_ONLY = '1'
process.stdin.resume()
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
void import('./server.js').catch(error => { console.error('Background worker failed to start.', error); process.exit(1) })
