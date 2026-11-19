import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envFile = resolve(root, 'backend', '.env')
const rl = createInterface({ input: stdin, output: stdout })
const ask = (label, fallback = '') => rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)

try {
  let prior = ''
  if (existsSync(envFile)) {
    prior = readFileSync(envFile, 'utf8')
    if (prior.includes('ISI_PASSWORD_POSTGRES_DI_SINI') || prior.includes('replace-this-with-a-random-secret')) {
      console.log('backend/.env masih berisi nilai contoh; setup akan menggantinya.')
    } else {
      const answer = (await ask('backend/.env sudah ada. Tulis ulang dengan kredensial baru? (y/N)', 'N')).trim().toLowerCase()
      if (answer !== 'y') {
        console.log('Konfigurasi tidak diubah. Pastikan DATABASE_URL di backend/.env menunjuk ke database energytrack.')
        process.exitCode = 0
        rl.close()
        process.exit()
      }
    }
  }

  const username = (await ask('Username PostgreSQL', 'postgres')).trim() || 'postgres'
  const password = await ask('Password PostgreSQL (kosongkan jika tidak digunakan)')
  const user = encodeURIComponent(username)
  const auth = password ? `${user}:${encodeURIComponent(password)}@` : `${user}@`
  const sessionSecret = randomBytes(32).toString('hex')
  const content = [
    `DATABASE_URL="postgresql://${auth}127.0.0.1:5432/energytrack?schema=public"`,
    `SESSION_SECRET="${sessionSecret}"`,
    'PORT=3000',
    'FRONTEND_ORIGIN="http://localhost:5173"',
    ''
  ].join('\n')
  writeFileSync(envFile, content, { encoding: 'utf8', mode: 0o600 })
  console.log('backend/.env dibuat. Menyiapkan skema database energytrack...')
  const prismaCli = resolve(root, 'node_modules', 'prisma', 'build', 'index.js')
  const migrate = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], { cwd: resolve(root, 'backend'), stdio: 'inherit' })
  if (migrate.status !== 0) throw new Error('Penerapan skema gagal. Pastikan PostgreSQL aktif, user memiliki CONNECT pada database serta CREATE pada schema public, dan kredensial di backend/.env benar.')
  console.log('Menyiapkan satu akun untuk tiap role (password: developer123)...')
  const tsxCli = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const seed = spawnSync(process.execPath, [tsxCli, 'prisma/seed.ts'], { cwd: resolve(root, 'backend'), stdio: 'inherit' })
  if (seed.status !== 0) throw new Error('Migrasi berhasil, tetapi seed gagal. Jalankan kembali seed setelah memperbaiki penyebabnya.')
  console.log('Database tersambung. Jalankan npm run dev dari folder proyek untuk membuka aplikasi.')
} catch (error) {
  console.error(`Setup database gagal: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  rl.close()
}
