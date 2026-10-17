/**
 * 从已经构建好的扩展打出两个商店/发布用归档。
 *
 * 有两条性质很重要，而且是在这里强制的，而不是留给手工上传的人：
 *
 * 1. **条目名用 `/`，绝不用 `\`。** 含有反斜杠条目的商店上传会被拒绝。这就是
 *    打包器是手写、而不是调 `Compress-Archive` 的原因：在 Windows 上那个 cmdlet
 *    会产出反斜杠条目，而 `zip` 在开箱的机器上并不存在。一个跑在 `node:zlib`
 *    之上的 ZIP writer 让整套工具没有依赖，并且在每个平台上都正确。
 * 2. **文件名带着里面那份 manifest 的版本号**，这样一个文件名和它的内容就无法
 *    互相矛盾。
 *
 * 用法（在仓库根目录，两个构建都做完之后）：
 *   node extension/scripts/package.mjs
 *
 * 把 `dsh-browser-crossplatform-<version>.zip`（Chrome）和
 * `dsh-browser-crossplatform-<version>-firefox.zip`（Firefox）写进仓库根目录；
 * 当 `--store` 构建存在时，还会写 `…-<version>-store.zip` /
 * `…-store-firefox.zip`。**要上传到商店的是 `-store` 归档**；另一对带着让开发
 * 扩展 id 保持稳定的 manifest `key`，Chrome Web Store 会拒绝它。
 */

import { deflateRawSync } from 'node:zlib'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const extensionDir = resolve(root, 'extension')

/** 日期/时间字段用 DOS 纪元；构建时间才是那个诚实值。 */
const DOS_EPOCH = new Date(1980, 0, 1).getTime()

/** 读一份已构建的 manifest，宁可大声报错，也不要发出去一份过期的 dist。 */
function readManifest(dir) {
  const file = resolve(extensionDir, dir, 'manifest.json')
  if (!existsSync(file)) {
    throw new Error(`${dir}/manifest.json is missing — build that target first (see README "Commands")`)
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** 两份目标 manifest 必须一致，那个版本号就是归档名。 */
function resolveVersion() {
  const chrome = readManifest('dist')
  const firefox = readManifest('dist-firefox')
  if (chrome.version !== firefox.version) {
    throw new Error(`dist is ${chrome.version} while dist-firefox is ${firefox.version}; rebuild both targets`)
  }
  return chrome.version
}

let crcTable

/** 标准 CRC-32（IEEE 802.3 多项式），惰性计算。 */
function crc32(buffer) {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** `dir` 下的每个文件，名字以 `/` 分隔、相对于 `dir`，已排序。 */
function collectFiles(dir, prefix = '') {
  const files = []
  for (const name of readdirSync(dir).sort()) {
    const absolute = resolve(dir, name)
    const entry = prefix === '' ? name : `${prefix}/${name}`
    if (statSync(absolute).isDirectory()) files.push(...collectFiles(absolute, entry))
    else files.push({ entry, absolute })
  }
  return files
}

/** 某个 mtime 对应的 MINIZIP 兼容日期/时间对。 */
function dosDateTime(mtime) {
  const date = new Date(Math.max(mtime, DOS_EPOCH))
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

/**
 * 把一个目录打成 ZIP buffer。
 * @param {string} sourceDir - 要打包的绝对目录。
 * @returns {Buffer} 归档。
 */
function packDirectory(sourceDir) {
  const files = collectFiles(sourceDir)
  const local = []
  const central = []
  let offset = 0
  for (const { entry, absolute } of files) {
    if (entry.includes('\\')) throw new Error(`refusing to pack a backslash entry: ${entry}`)
    const name = Buffer.from(entry, 'utf8')
    const content = readFileSync(absolute)
    const deflated = deflateRawSync(content, { level: 9 })
    const crc = crc32(content)
    const { time, day } = dosDateTime(statSync(absolute).mtimeMs)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0) // 本地文件头
    header.writeUInt16LE(20, 4) // 所需版本
    header.writeUInt16LE(0x0800, 6) // UTF-8 名称
    header.writeUInt16LE(8, 8) // deflate
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(day, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(deflated.length, 18)
    header.writeUInt32LE(content.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)
    local.push(header, name, deflated)

    const entryHeader = Buffer.alloc(46)
    entryHeader.writeUInt32LE(0x02014b50, 0) // 中央目录头
    entryHeader.writeUInt16LE(0x031e, 4) // made by: UNIX, 3.0
    entryHeader.writeUInt16LE(20, 6)
    entryHeader.writeUInt16LE(0x0800, 8)
    entryHeader.writeUInt16LE(8, 10)
    entryHeader.writeUInt16LE(time, 12)
    entryHeader.writeUInt16LE(day, 14)
    entryHeader.writeUInt32LE(crc, 16)
    entryHeader.writeUInt32LE(deflated.length, 20)
    entryHeader.writeUInt32LE(content.length, 24)
    entryHeader.writeUInt16LE(name.length, 28)
    entryHeader.writeUInt32LE(0o100644 * 0x10000, 38) // 外部属性：-rw-r--r--
    entryHeader.writeUInt32LE(offset, 42)
    central.push(entryHeader, name)

    offset += header.length + name.length + deflated.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // 中央目录结束记录
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBuffer, end])
}

/** 把一个构建目录打成 `<仓库根>/<name>` 并报告结果。 */
function writeArchive(sourceDir, outputName) {
  const target = resolve(root, outputName)
  rmSync(target, { force: true })
  const archive = packDirectory(resolve(extensionDir, sourceDir))
  writeFileSync(target, archive)
  return { target, bytes: archive.length, files: collectFiles(resolve(extensionDir, sourceDir)).length }
}

const version = resolveVersion()
const archives = [
  writeArchive('dist', `dsh-browser-crossplatform-${version}.zip`),
  writeArchive('dist-firefox', `dsh-browser-crossplatform-${version}-firefox.zip`),
]
// 商店归档来自 `--store` 构建，它们的 manifest 里没有 `key`。
// Chrome Web Store 会拒绝带着 key 的上传（"清单文件中不得包含 key
// 字段"），而开发构建需要它来保持一个可预测的扩展 id。
// 在这里而不是手工打包，就是为了不让两者被搞混：文件名说明了哪个是哪个。
for (const [dir, suffix] of [['dist-store', '-store'], ['dist-firefox-store', '-store-firefox']]) {
  if (existsSync(resolve(extensionDir, dir))) {
    archives.push(writeArchive(dir, `dsh-browser-crossplatform-${version}${suffix}.zip`))
  }
}
for (const { target, bytes, files } of archives) {
  console.log(`wrote ${target} (${files} files, ${bytes} bytes)`)
}
