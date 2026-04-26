/**
 * プロジェクト WS 接続レジストリ (in-memory)
 *
 * project_credentials で /ws/project に繋いでいる外部サービス
 * (Schedula 等) の接続を追跡する。ダッシュボードの「使用中」表示や
 * 死活監視に使う。
 *
 * - プロセスローカル (multi-instance では各インスタンスが自分の接続のみ追跡)
 * - 接続が切れたら 30 秒間 lastConnectedAt を保持する (連続再接続でフリッカ
 *   しないように "最後にアクティブだった瞬間" の判定窓を持つ)
 */

import { devLog } from "../logging/dev-logger.js";

interface ConnectionEntry {
  connectionId: string;
  clientId: string;
  connectedAt: Date;
}

interface ProjectStatus {
  /** 現在 OPEN な接続数 */
  connectionCount: number;
  /** 直近に接続が確立 (open) したタイムスタンプ。null は一度も繋がっていない */
  lastConnectedAt: Date | null;
  /** 直近に接続が切断 (close) したタイムスタンプ */
  lastDisconnectedAt: Date | null;
}

const connections = new Map<string, Map<string, ConnectionEntry>>();
const lastDisconnectedAt = new Map<string, Date>();
const lastConnectedAt = new Map<string, Date>();

export function addConnection(projectKey: string, connectionId: string, clientId: string): void {
  let map = connections.get(projectKey);
  if (!map) {
    map = new Map();
    connections.set(projectKey, map);
  }
  const now = new Date();
  map.set(connectionId, { connectionId, clientId, connectedAt: now });
  lastConnectedAt.set(projectKey, now);
  devLog("project-registry.add", {
    projectKey,
    connectionId,
    clientId,
    total: map.size,
  });
}

export function removeConnection(projectKey: string, connectionId: string): void {
  const map = connections.get(projectKey);
  if (!map) return;
  map.delete(connectionId);
  lastDisconnectedAt.set(projectKey, new Date());
  if (map.size === 0) {
    connections.delete(projectKey);
  }
  devLog("project-registry.remove", {
    projectKey,
    connectionId,
    remaining: map.size,
  });
}

/** 単一プロジェクトの状態 (接続 0 でも null は返さず connectionCount=0) */
export function getProjectStatus(projectKey: string): ProjectStatus {
  const map = connections.get(projectKey);
  return {
    connectionCount: map?.size ?? 0,
    lastConnectedAt: lastConnectedAt.get(projectKey) ?? null,
    lastDisconnectedAt: lastDisconnectedAt.get(projectKey) ?? null,
  };
}

/** 全プロジェクトの状態を一括取得 (ダッシュボード一覧表示用) */
export function getAllProjectStatus(): Map<string, ProjectStatus> {
  const result = new Map<string, ProjectStatus>();
  // 過去に繋がったことのある全 projectKey を網羅
  const allKeys = new Set<string>([
    ...connections.keys(),
    ...lastConnectedAt.keys(),
  ]);
  for (const key of allKeys) {
    result.set(key, getProjectStatus(key));
  }
  return result;
}

/** 単一プロジェクトの接続詳細 (admin 用、clientId/connectedAt まで返す) */
export function getProjectConnections(projectKey: string): ConnectionEntry[] {
  const map = connections.get(projectKey);
  if (!map) return [];
  return Array.from(map.values());
}
