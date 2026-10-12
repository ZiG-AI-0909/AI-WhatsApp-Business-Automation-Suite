import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
// The whole project uses ONE env file: backend/.env (loaded by the backend's
// server.js). Vite reads VITE_* vars from the same file — anything without
// the VITE_ prefix stays server-side and is never exposed to the client.
const backendEnvPath = path.resolve(currentDir, '../backend/.env')
const envDir = fs.existsSync(backendEnvPath) ? path.resolve(currentDir, '../backend') : currentDir

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  envDir,
})
