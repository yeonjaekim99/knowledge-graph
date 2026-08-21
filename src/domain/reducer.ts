/** A reducer is pure when its result depends only on these explicit inputs. */
export type PureReducer<State, Event> = (
  state: Readonly<State>,
  event: Readonly<Event>,
) => State;

/**
 * Applies events in caller-provided journal order without consulting IO, clocks,
 * process state, or adapters. Event semantics are implemented by later PRJ tasks.
 */
export function reduceEvents<State, Event>(
  initialState: State,
  events: readonly Event[],
  reducer: PureReducer<State, Event>,
): State {
  let state = initialState;

  for (const event of events) {
    state = reducer(state, event);
  }

  return state;
}
