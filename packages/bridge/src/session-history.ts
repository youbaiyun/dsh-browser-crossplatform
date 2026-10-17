/**
 * Session 历史解码：`session/follow` 基线、它的记录，以及更旧的日志还在用的紧凑
 * chunk-row 展开。
 *
 * @module dsh-browser-crossplatform/src/session-history
 */

import { openWireStream, type PeerLike, type TypertGatewayLike } from './dsh-gateway.ts'
import { isRecord } from './host-api.ts'

export interface SessionSnapshot {
  /** session/follow 返回的宿主机日志顶端（含端点）；后续的 session/page 调用需要它。 */
  readonly cursor: number
  readonly records: readonly unknown[]
  readonly hasMore: boolean
  readonly projections?: unknown
  readonly assistantStream?: unknown
  readonly snapshotId?: string
}

export async function oneShotSessionSnapshot(
  gateway: TypertGatewayLike,
  sessionId: string,
  outerSignal: AbortSignal,
  peer: PeerLike | undefined,
  maxMessages?: number,
): Promise<SessionSnapshot> {
  const controller = new AbortController()
  const signal = AbortSignal.any([outerSignal, controller.signal])
  const source = await openWireStream(gateway,
    'session/follow',
    {
      args: {
        request: {
          address: { kind: 'session', sessionId },
          assistantStream: true,
          ...(maxMessages === undefined ? {} : { maxMessages }),
        },
      },
    },
    signal,
    peer,
  )
  const iterator = source[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    if (first.done || !isSessionSnapshot(first.value)) {
      throw new TypeError('session/follow did not begin with a snapshot')
    }
    return {
      cursor: first.value.cursor,
      records: first.value.records,
      hasMore: first.value.hasMore,
      ...(first.value.projections === undefined ? {} : { projections: first.value.projections }),
      ...(first.value.assistantStream === undefined ? {} : { assistantStream: first.value.assistantStream }),
    }
  } finally {
    controller.abort(new Error('Session snapshot received'))
    await iterator.return?.()
  }
}

export function historyValue(snapshot: SessionSnapshot): Record<string, unknown> {
  return {
    // V3 记录仍然是带内嵌 Assistant 流的持久事件。给旧的日志/宿主机保留传统的
    // chunk-row 解码器，但别给新的进程内 assistant 流配合成的持久 seq。
    events: snapshot.records.flatMap(historyRecordEvents).map(event => ({ event })),
    hasMore: snapshot.hasMore,
    ...(snapshot.projections === undefined ? {} : { projections: snapshot.projections }),
    ...(snapshot.assistantStream === undefined ? {} : { assistantStream: snapshot.assistantStream }),
    ...(snapshot.snapshotId === undefined ? {} : { snapshotId: snapshot.snapshotId }),
  }
}

export function historyPageValue(page: unknown): Record<string, unknown> {
  if (!isRecord(page) || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') {
    throw new TypeError('session/page returned an invalid history page')
  }
  return historyValue({
    cursor: -1,
    records: page.records,
    hasMore: page.hasMore,
    ...(page.projections === undefined ? {} : { projections: page.projections }),
  })
}

export function optionalNonNegativeInteger(
  payload: unknown,
  key: string,
): number | undefined {
  if (!isRecord(payload) || !(key in payload) || payload[key] === undefined) return undefined
  const value = payload[key]
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw new TypeError(`${key} must be a non-negative safe integer`)
  }
  return value as number
}

export function optionalPositiveInteger(
  payload: unknown,
  key: string,
): number | undefined {
  if (!isRecord(payload) || !(key in payload) || payload[key] === undefined) return undefined
  const value = payload[key]
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${key} must be a positive safe integer`)
  }
  return value as number
}

function historyRecordEvents(record: unknown): Record<string, unknown>[] {
  if (!isRecord(record)
    || (record.type !== 'event' && record.type !== 'chunks')
    || !isRecord(record.event)) {
    throw new TypeError('session history carried an invalid record')
  }
  const event = record.event
  if (!isChunkRowEvent(event)) {
    if (record.type === 'chunks') {
      throw new TypeError('session history chunks record carried a non-chunk event')
    }
    return [event]
  }

  const data = event.data
  const members = event.type === 'chunkrow/tool-call-chunks' ? data.args : data.texts
  const deltas = data.dt
  if (!Array.isArray(members) || members.length === 0 || members.some(member => typeof member !== 'string')
    || !Array.isArray(deltas) || deltas.length !== members.length - 1
    || deltas.some(delta => !Number.isSafeInteger(delta))) {
    throw new TypeError(`${event.type} carried an invalid compact run`)
  }
  if (members.length - 1 > Number.MAX_SAFE_INTEGER - event.seq) {
    throw new TypeError(`${event.type} sequence range is unsafe`)
  }

  const events: Record<string, unknown>[] = []
  let time = event.time
  for (let index = 0; index < members.length; index += 1) {
    if (index > 0) time += deltas[index - 1] as number
    if (!Number.isSafeInteger(time)) throw new TypeError(`${event.type} timestamp range is unsafe`)
    const chunk = compactChunk(event.type, data, members[index] as string)
    events.push({
      type: 'assistant/chunk',
      seq: event.seq + index,
      time,
      data: { turn: data.turn, step: data.step, chunk },
    })
  }
  return events
}

type ChunkRowEvent = {
  readonly type: 'chunkrow/text-chunks' | 'chunkrow/reasoning-chunks' | 'chunkrow/tool-call-chunks'
  readonly seq: number
  readonly time: number
  readonly data: Record<string, unknown> & {
    readonly turn: number
    readonly step: number
    readonly index: number
    readonly dt: readonly unknown[]
    readonly texts?: readonly unknown[]
    readonly args?: readonly unknown[]
  }
}

function isChunkRowEvent(event: Record<string, unknown>): event is ChunkRowEvent {
  if (event.type !== 'chunkrow/text-chunks'
    && event.type !== 'chunkrow/reasoning-chunks'
    && event.type !== 'chunkrow/tool-call-chunks') return false
  if (!Number.isSafeInteger(event.seq) || (event.seq as number) < 0 || !Number.isSafeInteger(event.time)
    || !isRecord(event.data)) {
    throw new TypeError(`${String(event.type)} carried an invalid compact envelope`)
  }
  const data = event.data
  if (typeof data.turn !== 'number' || typeof data.step !== 'number' || typeof data.index !== 'number') {
    throw new TypeError(`${String(event.type)} carried invalid compact coordinates`)
  }
  if (event.type === 'chunkrow/tool-call-chunks'
    && (typeof data.id !== 'string' || (data.name !== undefined && typeof data.name !== 'string'))) {
    throw new TypeError(`${event.type} carried an invalid tool identity`)
  }
  return true
}

function compactChunk(
  type: ChunkRowEvent['type'],
  data: ChunkRowEvent['data'],
  member: string,
): Record<string, unknown> {
  if (type === 'chunkrow/text-chunks') {
    return { type: 'text-delta', index: data.index, text: member }
  }
  if (type === 'chunkrow/reasoning-chunks') {
    return { type: 'reasoning-delta', index: data.index, text: member }
  }
  return {
    type: 'tool-call-delta',
    index: data.index,
    id: data.id,
    ...(data.name === undefined ? {} : { name: data.name }),
    argumentsDelta: member,
  }
}

export function isSessionSnapshot(value: unknown): value is {
  readonly type: 'snapshot'
  readonly cursor: number
  readonly records: readonly unknown[]
  readonly hasMore: boolean
  readonly projections?: unknown
  readonly assistantStream?: unknown
} {
  return isRecord(value)
    && value.type === 'snapshot'
    && Number.isSafeInteger(value.cursor)
    && (value.cursor as number) >= -1
    && (value.cursor as number) !== Number.MAX_SAFE_INTEGER
    && Array.isArray(value.records)
    && typeof value.hasMore === 'boolean'
}
