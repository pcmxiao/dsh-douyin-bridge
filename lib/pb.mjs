/**
 * lib/pb.mjs —— 极简 protobuf 线格式解码器（**不需要 .proto 文件**）
 * ============================================================================
 * 为什么要有这个文件：
 *
 * 抖音的私信接口 `imapi.douyin.com/v1|v2|v3/*` 返回的是 **application/x-protobuf**。
 * 想绕开 DOM 直接读消息，就必须能解开它。
 *
 * 但我们**没有 .proto 定义**，也不想去逆向 schema —— 所以这里只做
 * **线格式（wire format）层面的通用解码**：
 *
 *   · 每个字段 = (field number, wire type, value)
 *   · wire type 2（length-delimited）里可能是**嵌套消息**、**字符串**或**原始字节**
 *   · 判断方法：试着当嵌套消息解一遍，如果能**刚好吃完整个 buffer**，就是嵌套消息；
 *     否则就是字符串/字节
 *
 * 这样解出来的是一棵「字段树」，不含语义名字，但足够：
 *   · 按字段号取值（`get(tree, 3)`）
 *   · 把所有可读字符串捞出来（`strings(tree)`）
 *
 * 抖音改版时字段号一般不变（变的只是 DOM），所以这比解析 DOM 稳得多。
 */

/** 读一个 varint。protobuf 的 varint 最多 10 字节。 */
function readVarint(buf, pos) {
  let result = 0
  let shift = 0
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new Error('varint 越界')
    const byte = buf[pos++]
    // 用乘法而不是位运算：位运算会被截断成 32 位，时间戳这种大数会错
    result += (byte & 0x7f) * Math.pow(2, shift)
    if ((byte & 0x80) === 0) return { value: result, pos }
    shift += 7
  }
  throw new Error('varint 太长')
}

const WIRE_VARINT = 0
const WIRE_64 = 1
const WIRE_LEN = 2
const WIRE_32 = 5

/**
 * 解一层 protobuf。
 *
 * @param {Buffer} buf
 * @returns {Array<{field:number, wire:number, value:number|Buffer}>}
 */
export function parseFields(buf) {
  const out = []
  let pos = 0
  while (pos < buf.length) {
    const t = readVarint(buf, pos)
    pos = t.pos
    const field = Math.floor(t.value / 8)
    const wire = t.value & 7
    if (field === 0) throw new Error('field 0 不合法')

    if (wire === WIRE_VARINT) {
      const v = readVarint(buf, pos)
      pos = v.pos
      out.push({ field, wire, value: v.value })
    } else if (wire === WIRE_LEN) {
      const len = readVarint(buf, pos)
      pos = len.pos
      const n = len.value
      if (pos + n > buf.length) throw new Error('length 越界')
      out.push({ field, wire, value: buf.subarray(pos, pos + n) })
      pos += n
    } else if (wire === WIRE_64) {
      if (pos + 8 > buf.length) throw new Error('fixed64 越界')
      out.push({ field, wire, value: buf.subarray(pos, pos + 8) })
      pos += 8
    } else if (wire === WIRE_32) {
      if (pos + 4 > buf.length) throw new Error('fixed32 越界')
      out.push({ field, wire, value: buf.subarray(pos, pos + 4) })
      pos += 4
    } else {
      // wire 3/4 是已废弃的 group，遇到就停
      throw new Error(`不支持的 wire type ${wire}`)
    }
  }
  return out
}

/** 一段 buffer 是否「像」合法的 protobuf（能刚好解完、字段号合理） */
function looksLikeMessage(buf) {
  if (!buf || buf.length === 0) return false
  try {
    const fields = parseFields(buf)
    if (fields.length === 0) return false
    // 字段号太大基本就是文本/随机字节被误判
    if (fields.some((f) => f.field > 5000)) return false
    return true
  } catch {
    return false
  }
}

/** 是否像可读文本（UTF-8 且不含控制字符） */
function looksLikeText(buf) {
  if (!buf || buf.length === 0) return false
  if (buf.length > 4096) return false
  const s = buf.toString('utf8')
  // 替换字符说明不是合法 UTF-8
  if (s.includes('\uFFFD')) return false
  // 允许换行/制表，但不允许其他控制字符
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)) return false
  return true
}

/**
 * 解成树。
 *
 * 每个节点：`{ field, kind: 'varint'|'bytes'|'string'|'message', value, children? }`
 *
 * @param {Buffer} buf
 * @param {number} depth 递归深度上限，防炸
 */
export function parseTree(buf, depth = 0) {
  if (depth > 12) return []
  const fields = parseFields(buf)
  const out = []
  for (const f of fields) {
    if (f.wire === WIRE_VARINT) {
      out.push({ field: f.field, kind: 'varint', value: f.value })
      continue
    }
    if (f.wire === WIRE_64 || f.wire === WIRE_32) {
      out.push({ field: f.field, kind: 'bytes', value: f.value })
      continue
    }
    // length-delimited：先试嵌套消息，再试文本
    const sub = f.value
    if (looksLikeMessage(sub)) {
      out.push({ field: f.field, kind: 'message', value: sub, children: parseTree(sub, depth + 1) })
    } else if (looksLikeText(sub)) {
      out.push({ field: f.field, kind: 'string', value: sub.toString('utf8') })
    } else {
      out.push({ field: f.field, kind: 'bytes', value: sub })
    }
  }
  return out
}

/** 取某个字段号的第一个值（不管类型） */
export function get(tree, field) {
  return tree.find((n) => n.field === field)
}

/** 取某个字段号的所有值 */
export function all(tree, field) {
  return tree.filter((n) => n.field === field)
}

/** 取某个字段号的字符串值 */
export function getString(tree, field) {
  const n = get(tree, field)
  return n && n.kind === 'string' ? n.value : ''
}

/** 取某个字段号的 varint 值 */
export function getInt(tree, field) {
  const n = get(tree, field)
  return n && n.kind === 'varint' ? n.value : undefined
}

/** 取某个字段号的嵌套消息 */
export function getMessage(tree, field) {
  const n = get(tree, field)
  return n && n.kind === 'message' ? n.children : null
}

/** 递归捞出所有可读字符串（可按最短长度过滤） */
export function strings(tree, minLen = 1) {
  const out = []
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.kind === 'string' && n.value.length >= minLen) out.push(n.value)
      else if (n.kind === 'message') walk(n.children)
    }
  }
  walk(tree)
  return out
}

/** 把树打成便于人看的多行文本（调试用） */
export function dump(tree, depth = 0, maxDepth = 6) {
  const lines = []
  const pad = '  '.repeat(depth)
  for (const n of tree) {
    if (depth > maxDepth) { lines.push(`${pad}…`); break }
    if (n.kind === 'varint') {
      lines.push(`${pad}#${n.field} = ${n.value}`)
    } else if (n.kind === 'string') {
      const s = n.value.length > 90 ? `${n.value.slice(0, 90)}…` : n.value
      lines.push(`${pad}#${n.field} str(${n.value.length}) "${s.replace(/\n/g, '\\n')}"`)
    } else if (n.kind === 'bytes') {
      lines.push(`${pad}#${n.field} bytes(${n.value.length}) ${n.value.subarray(0, 12).toString('hex')}`)
    } else {
      lines.push(`${pad}#${n.field} {`)
      lines.push(...dump(n.children, depth + 1, maxDepth))
      lines.push(`${pad}}`)
    }
  }
  return lines
}
