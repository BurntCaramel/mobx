import {IObservable, IDepTreeNode, propagateReadiness, propagateStaleness, addObserver, removeObserver} from "./observable";
import {globalState, resetGlobalState} from "./globalstate";
import {quickDiff, invariant} from "../utils/utils";
import {isSpyEnabled, spyReport} from "./spy";

/**
 * A derivation is everything that can be derived from the state (all the atoms) in a pure manner.
 * See https://medium.com/@mweststrate/becoming-fully-reactive-an-in-depth-explanation-of-mobservable-55995262a254#.xvbh6qd74
 */
export interface IDerivation extends IDepTreeNode, IObservable {
	observing: IObservable[];
	staleObservers: IDerivation[];
	observers: IDerivation[];
	dependencyStaleCount: number;
	dependencyChangeCount: number;
	onDependenciesReady(): boolean;
}

export function isComputingDerivation() {
	return globalState.derivationStack.length > 0;
}

export function checkIfStateModificationsAreAllowed() {
	if (!globalState.allowStateChanges) {
		invariant(false, globalState.strictMode
			? "It is not allowed to create or change state outside an `action` when MobX is in strict mode. Wrap the current method in `action` if this state change is intended"
			: "It is not allowed to change the state when a computed value or transformer is being evaluated. Use 'autorun' to create reactive functions with side-effects."
		);
	}
}

/**
 * Notify a derivation that one of the values it is observing has become stale
 */
export function notifyDependencyStale(derivation: IDerivation) {
	if (++derivation.dependencyStaleCount === 1) {
		propagateStaleness(derivation);
	}
}

/**
 * Notify a derivation that one of the values it is observing has become stable again.
 * If all observed values are stable and at least one of them has changed, the derivation
 * will be scheduled for re-evaluation.
 */
export function notifyDependencyReady(derivation: IDerivation, dependencyDidChange: boolean) {
	invariant(derivation.dependencyStaleCount > 0, "unexpected ready notification");
	if (dependencyDidChange)
		derivation.dependencyChangeCount += 1;
	if (--derivation.dependencyStaleCount === 0) {
		// all dependencies are ready
		if (derivation.dependencyChangeCount > 0) {
			// did any of the observables really change?
			derivation.dependencyChangeCount = 0;
			const changed = derivation.onDependenciesReady();
			propagateReadiness(derivation, changed);
		} else {
			// we're done, but didn't change, lets make sure verybody knows..
			propagateReadiness(derivation, false);
		}
	}
}

/**
 * Executes the provided function `f` and tracks which observables are being accessed.
 * The tracking information is stored on the `derivation` object and the derivation is registered
 * as observer of any of the accessed observables.
 */
export function trackDerivedFunction<T>(derivation: IDerivation, f: () => T) {
	let hasException = true;
	const prevObserving = derivation.observing;
	derivation.observing = [];
	globalState.derivationStack.push(derivation);
	const prevTracking = globalState.isTracking;
	globalState.isTracking = true;
	try {
		const result = f.call(derivation);
		hasException = false;
		bindDependencies(derivation, prevObserving);
		globalState.isTracking = prevTracking;
		return result;
	} finally {
		if (hasException) {
			const message = (
				`[mobx] An uncaught exception occurred while calculating your computed value, autorun or transformer. Or inside the render() method of an observer based React component. ` +
				`These methods should never throw exceptions as MobX will usually not be able to recover from them. ` +
				`Please enable 'Pause on (caught) exceptions' in your debugger to find the root cause. In: '${derivation.name}'`
			);
			if (isSpyEnabled()) {
				spyReport({
					type: "error",
					object: this,
					message
				});
			}
			console.error(message);
			// Poor mans recovery attempt
			// Assumption here is that this is the only exception handler in MobX.
			// So functions higher up in the stack (like transanction) won't be modifying the globalState anymore after this call.
			// (Except for other trackDerivedFunction calls of course, but that is just)
			resetGlobalState();
		}
	}
}

function bindDependencies(derivation: IDerivation, prevObserving: IObservable[]) {
	globalState.derivationStack.length -= 1;

	let [added, removed] = quickDiff(derivation.observing, prevObserving);

	for (let i = 0, l = added.length; i < l; i++) {
		let dependency = added[i];
		// only check for cycles on new dependencies, existing dependencies cannot cause a cycle..
		invariant(!findCycle(derivation, dependency), `Cycle detected`, derivation);
		addObserver(added[i], derivation);
	}

	// remove observers after adding them, so that they don't go in lazy mode to early
	for (let i = 0, l = removed.length; i < l; i++)
		removeObserver(removed[i], derivation);
}

/**
 * Find out whether the dependency tree of this derivation contains a cycle, as would be the case in a
 * computation like `a = a * 2`
 */
function findCycle(needle: IDerivation, node: IObservable): boolean {
	if (needle === node)
		return true;
	const obs = node.observing;
	if (obs === undefined)
		return false;
	for (let l = obs.length, i = 0; i < l; i++)
		if (findCycle(needle, obs[i]))
			return true;
	return false;
}


export function untracked<T>(action: () => T): T {
	const prevTracking = globalState.isTracking;
	globalState.isTracking = false;
	const res = action();
	globalState.isTracking = prevTracking;
	return res;
}
