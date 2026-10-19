/**
 * Serialized `/state` contract shared by the host and its browser/Electron consumers.
 *
 * The DSH host imports these declarations with `import type` only. They disappear from
 * the emitted plugin bundle, preserving the host's single-file runtime requirement.
 */
export type StateSectionName = 'balance' | 'workStatus' | 'notify' | 'config';

export type PetLeafName = 'say' | 'anim' | 'position' | 'throw';

/** A versioned state leaf. `data: null` means the leaf has not been written. */
export interface StateLeaf<T = unknown> {
  counter: number;
  data: T;
}

/** State store payload before host-specific transport capabilities are added. */
export interface StateStoreSnapshot {
  /** Version of the whole state, equal to the counter of the latest write. */
  counter: number;
  sections: Record<StateSectionName, StateLeaf>;
  pets: Record<string, Record<PetLeafName, StateLeaf>>;
}

/** Exact host response shape for `GET /state`. */
export interface StateSnapshot extends StateStoreSnapshot {
  /** Omitted when the host supports long polling; false marks standalone file-bridge mode. */
  longPoll?: false;
}
