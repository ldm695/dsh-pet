/**
 * 读取已安装的 DSH、Codex 与 Claude Code 状态桥接文件。
 * 独立模式没有 DSH 事件总线，因此由 /state 请求按需读取；文件旧、损坏或协议不兼容时安全忽略。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WORK_STATUS_STATES, type WorkStatusAgentSnapshot } from '../shared/work-status.ts';

interface BridgeAgent {
  key: string;
  state: WorkStatusAgentSnapshot['state'];
  revision: number;
  startedAt: number;
  eventAt: number;
  task?: string | null;
}

interface BridgeFile {
  version?: unknown;
  updatedAt?: unknown;
  eventAt?: unknown;
  agents?: unknown;
  notification?: {
    revision?: unknown;
    title?: unknown;
    body?: unknown;
    icon?: unknown;
    createdAt?: unknown;
    sourceForeground?: unknown;
  } | null;
}

export interface StandaloneBridgeNotification {
  revision: string;
  title: string;
  body: string;
  icon: string;
  sourceForeground: boolean;
}

export interface StandaloneWorkStatusBridge {
  readAgents(): WorkStatusAgentSnapshot[];
  takeNotification(): StandaloneBridgeNotification | undefined;
}

const SOURCE_NAMES = { dsh: 'DeepSeek Harness', codex: 'Codex', claude: 'Claude Code' } as const;
const IN_PROGRESS = new Set(['thinking', 'working', 'result', 'waiting']);
const NOTIFY_ICONS = new Set(['notify-done', 'notify-error', 'notify-truncated', 'notify-approval', 'notify-question']);
const MAX_AGE_MS = 3500;
const NOTIFICATION_MAX_AGE_MS = 15_000;

/**
 * 创建独立模式状态文件读取器。
 * @param dshHome - DSH 数据目录根路径。
 * @param warn - 首次发现桥接协议不兼容时调用。
 */
export function createStandaloneWorkStatusBridge(
  dshHome: string,
  warn: (message: string) => void = () => {},
): StandaloneWorkStatusBridge {
  const files = {
    dsh: join(dshHome, 'dsh-pet', 'work-status-bridge.json'),
    codex: join(dshHome, 'dsh-pet', 'codex-work-status-bridge.json'),
    claude: join(dshHome, 'dsh-pet', 'claude-code-work-status-bridge.json'),
  };
  const revisions = new Map<string, { signature: string; revision: number }>();
  const notified = new Map<string, string>();
  const warned = new Map<string, string>();
  let pendingNotification: StandaloneBridgeNotification | undefined;

  const read = (source: keyof typeof files): BridgeFile | undefined => {
    try {
      return JSON.parse(readFileSync(files[source], 'utf8')) as BridgeFile;
    } catch {
      return undefined;
    }
  };

  const compatible = (source: keyof typeof files, bridge: BridgeFile | undefined): bridge is BridgeFile => {
    if (!bridge) return false;
    const issue =
      bridge.version !== 2
        ? `version=${String(bridge.version ?? 'missing')}`
        : !Array.isArray(bridge.agents)
          ? 'agents array is missing'
          : '';
    if (!issue) {
      warned.delete(source);
      return true;
    }
    if (warned.get(source) !== issue) {
      warned.set(source, issue);
      warn(`忽略 ${source} 工作状态桥接文件（${issue}）；请更新对应桥接插件。`);
    }
    return false;
  };

  const isFresh = (bridge: BridgeFile, now: number): boolean => {
    const updatedAt = Number(bridge.updatedAt);
    return Number.isFinite(updatedAt) && now - updatedAt < MAX_AGE_MS && now >= updatedAt;
  };

  function readAgents(): WorkStatusAgentSnapshot[] {
    const now = Date.now();
    const sources = (Object.keys(files) as Array<keyof typeof files>).flatMap((source) => {
      const bridge = read(source);
      if (!compatible(source, bridge) || !isFresh(bridge, now)) return [];
      const agents = (bridge.agents as unknown[]).flatMap((value): BridgeAgent[] => {
        if (!value || typeof value !== 'object') return [];
        const item = value as Record<string, unknown>;
        if (
          typeof item.key !== 'string' ||
          !item.key ||
          typeof item.state !== 'string' ||
          !(WORK_STATUS_STATES as readonly string[]).includes(item.state) ||
          !Number.isSafeInteger(item.revision) ||
          !Number.isFinite(item.startedAt)
        )
          return [];
        return [
          {
            key: `${source}:${item.key}`,
            state: item.state as WorkStatusAgentSnapshot['state'],
            revision: item.revision as number,
            startedAt: item.startedAt as number,
            eventAt: Number(item.eventAt ?? bridge.eventAt ?? bridge.updatedAt) || now,
            ...(typeof item.task === 'string' ? { task: item.task } : {}),
          },
        ];
      });
      if (source === 'dsh') {
        const notice = bridge.notification;
        const noticeRevision = `${String(notice?.createdAt ?? '')}:${String(notice?.revision ?? '')}`;
        const createdAt = Number(notice?.createdAt);
        if (
          notice &&
          noticeRevision !== notified.get(source) &&
          Number.isFinite(createdAt) &&
          now >= createdAt &&
          now - createdAt <= NOTIFICATION_MAX_AGE_MS &&
          typeof notice.title === 'string' &&
          typeof notice.body === 'string'
        ) {
          notified.set(source, noticeRevision);
          pendingNotification = {
            revision: noticeRevision,
            title: notice.title,
            body: notice.body,
            icon: typeof notice.icon === 'string' && NOTIFY_ICONS.has(notice.icon) ? notice.icon : 'notify-done',
            sourceForeground: notice.sourceForeground === true,
          };
        }
      }
      if (!agents.length) return [];
      const active = agents.filter((agent) => IN_PROGRESS.has(agent.state));
      const candidates = active.length ? active : agents;
      const latest = candidates.reduce(
        (best, agent) => (!best || agent.eventAt > best.eventAt ? agent : best),
        undefined as BridgeAgent | undefined,
      );
      if (!latest) return [];
      const terminal = latest.state === 'success' || latest.state === 'error';
      const signature = JSON.stringify([latest.key, latest.state, latest.startedAt, terminal ? null : latest.revision]);
      const previous = revisions.get(source);
      const revision = previous?.signature === signature ? previous.revision : (previous?.revision ?? 0) + 1;
      revisions.set(source, { signature, revision });
      return [
        {
          ...latest,
          key: `${source}:client`,
          sourceName: SOURCE_NAMES[source],
          revision,
        },
      ];
    });
    return sources.sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key));
  }

  function takeNotification(): StandaloneBridgeNotification | undefined {
    const current = pendingNotification;
    pendingNotification = undefined;
    return current;
  }

  return { readAgents, takeNotification };
}
