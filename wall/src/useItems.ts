import { useCallback, useEffect, useRef, useState } from 'react';
import type { Table } from 'apache-arrow';
import type { Item } from './schema';
import { itemsFromArrow, storeFromArrow, storeFromItems, type ItemStore } from './store';

export const POLL_MS = 10_000;

/** What a host's feed answers: every item, or with `since` only what changed.
 *  Objects suit tens of thousands of items; past that, send an Arrow table in
 *  index order. */
export type ItemsBody<T extends Item> =
  | { items: readonly T[]; version: string }
  | { table: Table | readonly Table[]; version: string };

/** A host's item feed: the full list, or with `since` only what changed. */
export type FetchItems<T extends Item> = (slot: string, since?: string) => Promise<ItemsBody<T>>;

export function storeOf<T extends Item>(body: ItemsBody<T>): ItemStore<T> {
  return 'table' in body ? storeFromArrow<T>(body.table) : storeFromItems(body.items);
}

const deltaOf = <T extends Item>(body: ItemsBody<T>): readonly T[] =>
  ('table' in body
    ? (Array.isArray(body.table) ? body.table : [body.table as Table]).flatMap((t) => itemsFromArrow<T>(t))
    : body.items);

/** The wall's items, the slot they are for, and the rows the last poll replaced.
 *
 *  Items and slot travel together: a new slot beside the old slot's items
 *  fetches pictures that do not exist. Keeping both until the new ones arrive
 *  also stops the wall blanking on every switch. `changed` is null after a
 *  full load. */
export interface ItemsState<T extends Item> {
  store: ItemStore<T> | null;
  slot: string;
  changed: number[] | null;
}

/** `fetchItems` is an effect dependency, so a host passes a stable function.
 *  `poll` asks the feed for changes now rather than at the next tick. */
export function useItems<T extends Item>(fetchItems: FetchItems<T>, slot: string,
                                         pollMs = POLL_MS): ItemsState<T> & { poll: () => void } {
  const [state, setState] = useState<ItemsState<T>>({ store: null, slot, changed: null });
  const version = useRef('');
  const pollNow = useRef<() => void>(() => {});

  useEffect(() => {
    let live = true;
    version.current = '';
    void fetchItems(slot).then((body) => {
      if (!live) return;
      version.current = body.version;
      setState({ store: storeOf(body), slot, changed: null });
    });
    const poll = () => {
      void fetchItems(slot, version.current).then((body) => {
        if (!live) return;
        const delta = deltaOf(body);
        if (delta.length === 0) return;
        version.current = body.version;
        setState((prev) => {
          if (prev.slot !== slot || !prev.store) return prev;
          const { store, changed } = prev.store.patch(delta);
          return changed.length > 0 ? { slot, store, changed } : prev;
        });
      });
    };
    pollNow.current = poll;
    const timer = setInterval(poll, pollMs);
    return () => { live = false; clearInterval(timer); pollNow.current = () => {}; };
  }, [fetchItems, slot, pollMs]);

  const poll = useCallback(() => pollNow.current(), []);
  return { ...state, poll };
}
