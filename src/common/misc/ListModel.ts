import { ListLoadingState, ListState } from "../gui/base/List.js"
import {
	assertNonNull,
	binarySearch,
	defer,
	findBy,
	findLast,
	first,
	getFirstOrThrow,
	last,
	lastThrow,
	memoizedWithHiddenArgument,
	remove,
	setAddAll,
	setEquals,
	setMap,
	settledThen,
} from "@tutao/tutanota-utils"
import Stream from "mithril/stream"
import stream from "mithril/stream"
import { ListFetchResult, PageSize } from "../gui/base/ListUtils.js"
import { isOfflineError } from "../api/common/utils/ErrorUtils.js"
import { ListAutoSelectBehavior } from "./DeviceConfig.js"

/**
 * Specifies methods for retrieving items, fetching items, and comparing items for a ListModel.
 */
export interface ListModelConfig<ItemType, IdType> {
	/**
	 * Get the given number of entities starting after the given id. May return more items than requested, e.g. if all items are available on first fetch.
	 */
	fetch(lastFetchedItem: ItemType | null | undefined, count: number): Promise<ListFetchResult<ItemType>>

	/**
	 * Compare the items
	 * @return 0 if equal, less than 0 if less and greater than 0 if greater
	 */
	sortCompare(item1: ItemType, item2: ItemType): number

	/**
	 * @return the ID of the item
	 */
	getItemId(item: ItemType): IdType

	/**
	 * @return true if the IDs are the same
	 */
	isSameId(id1: IdType, id2: IdType): boolean

	autoSelectBehavior: () => ListAutoSelectBehavior
}

export type ListFilter<ItemType> = (item: ItemType) => boolean

type PrivateListState<ItemType> = Omit<ListState<ItemType>, "items" | "activeIndex"> & {
	unfilteredItems: ItemType[]
	filteredItems: ItemType[]
	activeItem: ItemType | null
}

/** ListModel that does the state upkeep for the List, including loading state, loaded items, selection and filters*/
export class ListModel<ItemType, IdType> {
	constructor(private readonly config: ListModelConfig<ItemType, IdType>) {}

	private initialLoading: Promise<unknown> | null = null
	private loading: Promise<unknown> = Promise.resolve()
	private filter: ListFilter<ItemType> | null = null
	private rangeSelectionAnchorItem: ItemType | null = null

	get state(): ListState<ItemType> {
		return this.stateStream()
	}

	private get rawState(): PrivateListState<ItemType> {
		return this.rawStateStream()
	}

	private defaultRawStateStream: PrivateListState<ItemType> = {
		unfilteredItems: [],
		filteredItems: [],
		inMultiselect: false,
		loadingStatus: ListLoadingState.Idle,
		loadingAll: false,
		selectedItems: new Set(),
		activeItem: null,
	}
	private rawStateStream: Stream<PrivateListState<ItemType>> = stream(this.defaultRawStateStream)

	readonly stateStream: Stream<ListState<ItemType>> = this.rawStateStream.map((state) => {
		const activeItem = state.activeItem
		const foundIndex = activeItem ? binarySearch(state.filteredItems, activeItem, (l, r) => this.config.sortCompare(l, r)) : -1
		const activeIndex = foundIndex < 0 ? null : foundIndex
		return { ...state, items: state.filteredItems, activeIndex }
	})

	readonly differentItemsSelected: Stream<ReadonlySet<ItemType>> = Stream.scan(
		(acc: ReadonlySet<ItemType>, state: ListState<ItemType>) => {
			const newSelectedIds = setMap(state.selectedItems, (item) => this.config.getItemId(item))
			const oldSelectedIds = setMap(acc, (item) => this.config.getItemId(item))
			if (setEquals(oldSelectedIds, newSelectedIds)) {
				// Stream.scan type definitions does not take it into account
				return Stream.SKIP as unknown as ReadonlySet<ItemType>
			} else {
				return state.selectedItems
			}
		},
		new Set(),
		this.stateStream,
	)

	private updateState(newStatePart: Partial<PrivateListState<ItemType>>) {
		this.rawStateStream({ ...this.rawState, ...newStatePart })
	}

	private waitUtilInit(): Promise<unknown> {
		const deferred = defer()
		const subscription = this.rawStateStream.map(() => {
			if (this.initialLoading != null) {
				Promise.resolve().then(() => {
					subscription.end(true)
					deferred.resolve(undefined)
				})
			}
		})
		return deferred.promise
	}

	async loadInitial() {
		// execute the loading only once
		if (this.initialLoading == null) {
			this.initialLoading = this.doLoad()
		}
		await this.initialLoading
	}

	async loadMore() {
		if (this.rawState.loadingStatus === ListLoadingState.Loading) {
			return this.loading
		}
		if (this.initialLoading == null || this.rawState.loadingStatus !== ListLoadingState.Idle) {
			return
		}
		await this.doLoad()
	}

	async retryLoading() {
		if (this.initialLoading == null || this.rawState.loadingStatus !== ListLoadingState.ConnectionLost) {
			return
		}
		await this.doLoad()
	}

	updateLoadingStatus(status: ListLoadingState) {
		if (this.rawState.loadingStatus === status) return

		this.updateState({ loadingStatus: status })
	}

	private async doLoad() {
		this.updateLoadingStatus(ListLoadingState.Loading)
		this.loading = Promise.resolve().then(async () => {
			const lastFetchedItem = last(this.rawState.unfilteredItems)
			try {
				const { items: newItems, complete } = await this.config.fetch(lastFetchedItem, PageSize)
				// if the loading was cancelled in the meantime, don't insert anything so that it's not confusing
				if (this.state.loadingStatus === ListLoadingState.ConnectionLost) {
					return
				}
				const newUnfilteredItems = [...this.rawState.unfilteredItems, ...newItems]
				newUnfilteredItems.sort(this.config.sortCompare)

				const newFilteredItems = [...this.rawState.filteredItems, ...this.applyFilter(newItems)]
				newFilteredItems.sort(this.config.sortCompare)

				const loadingStatus = complete ? ListLoadingState.Done : ListLoadingState.Idle
				this.updateState({ loadingStatus, unfilteredItems: newUnfilteredItems, filteredItems: newFilteredItems })
			} catch (e) {
				this.updateLoadingStatus(ListLoadingState.ConnectionLost)
				if (!isOfflineError(e)) {
					throw e
				}
			}
		})
		return this.loading
	}

	private applyFilter(newItems: ReadonlyArray<ItemType>): Array<ItemType> {
		return newItems.filter(this.filter ?? (() => true))
	}

	setFilter(filter: ListFilter<ItemType> | null) {
		this.filter = filter
		this.reapplyFilter()
	}

	reapplyFilter() {
		const newFilteredItems = this.applyFilter(this.rawState.unfilteredItems)

		const newSelectedItems = new Set(this.applyFilter([...this.state.selectedItems]))

		this.updateState({ filteredItems: newFilteredItems, selectedItems: newSelectedItems })
	}

	onSingleSelection(item: ItemType): void {
		this.updateState({ selectedItems: new Set([item]), inMultiselect: false, activeItem: item })
		this.rangeSelectionAnchorItem = item
	}

	/** An item was added to the selection. If multiselect was not on, discard previous single selection and only added selected item to the selection. */
	onSingleExclusiveSelection(item: ItemType): void {
		if (!this.rawState.inMultiselect) {
			this.updateState({ selectedItems: new Set([item]), inMultiselect: true, activeItem: item })
			this.rangeSelectionAnchorItem = item
		} else {
			const selectedItems = new Set(this.state.selectedItems)
			if (selectedItems.has(item)) {
				selectedItems.delete(item)
			} else {
				selectedItems.add(item)
			}
			if (selectedItems.size === 0) {
				this.updateState({ selectedItems, inMultiselect: false, activeItem: null })
				this.rangeSelectionAnchorItem = null
			} else {
				this.updateState({ selectedItems, inMultiselect: true, activeItem: item })
				this.rangeSelectionAnchorItem = item
			}
		}
	}

	/** An item was added to the selection. If multiselect was not on, add previous single selection and newly added selected item to the selection. */
	onSingleInclusiveSelection(item: ItemType, clearSelectionOnMultiSelectStart?: boolean): void {
		// If it isn't in MultiSelect, we discard all previous items
		// and start a new set of selected items in MultiSelect mode
		// we do it only if the user is on singleColumnMode, because
		// there are different expected behaviors there
		if (!this.state.inMultiselect && clearSelectionOnMultiSelectStart) {
			this.selectNone()
		}

		const selectedItems = new Set(this.state.selectedItems)

		if (this.state.inMultiselect && selectedItems.has(item)) {
			selectedItems.delete(item)
		} else {
			selectedItems.add(item)
		}

		if (selectedItems.size === 0) {
			this.updateState({ selectedItems, inMultiselect: false, activeItem: null })
			this.rangeSelectionAnchorItem = null
		} else {
			this.updateState({ selectedItems, inMultiselect: true, activeItem: item })
			this.rangeSelectionAnchorItem = item
		}
	}

	async loadAndSelect(finder: (item: ItemType) => boolean, shouldStop: () => boolean): Promise<ItemType | null> {
		await this.waitUtilInit()
		let foundItem: ItemType | undefined = undefined
		while (
			// if we did find the target mail, stop
			// make sure to call this before shouldStop or we might stop before trying to find an item
			// this can probably be optimized to be binary search in most (all?) cases
			!(foundItem = this.rawState.unfilteredItems.find(finder)) &&
			!shouldStop() &&
			// if we are done loading, stop
			this.rawState.loadingStatus !== ListLoadingState.Done &&
			// if we are offline, stop
			this.rawState.loadingStatus !== ListLoadingState.ConnectionLost
		) {
			await this.loadMore()
		}
		if (foundItem) {
			this.onSingleSelection(foundItem)
		}
		return foundItem ?? null
	}

	selectRangeTowards(item: ItemType): void {
		const selectedItems = new Set(this.state.selectedItems)
		if (selectedItems.size === 0) {
			selectedItems.add(item)
		} else {
			// we are trying to find the item that's closest to the clicked one
			// and after that we will select everything between the closest and the clicked one

			const clickedItemIndex: number = this.state.items.indexOf(item)
			let nearestSelectedIndex: number | null = null

			// find absolute min based on the distance (closest)
			for (const selectedItem of selectedItems) {
				const currentSelectedItemIndex = this.state.items.indexOf(selectedItem)

				if (nearestSelectedIndex == null || Math.abs(clickedItemIndex - currentSelectedItemIndex) < Math.abs(clickedItemIndex - nearestSelectedIndex)) {
					nearestSelectedIndex = currentSelectedItemIndex
				}
			}
			assertNonNull(nearestSelectedIndex)

			const itemsToAddToSelection: ItemType[] = []

			if (nearestSelectedIndex < clickedItemIndex) {
				for (let i = nearestSelectedIndex + 1; i <= clickedItemIndex; i++) {
					itemsToAddToSelection.push(this.state.items[i])
				}
			} else {
				for (let i = clickedItemIndex; i < nearestSelectedIndex; i++) {
					itemsToAddToSelection.push(this.state.items[i])
				}
			}

			setAddAll(selectedItems, itemsToAddToSelection)
		}
		this.updateState({ selectedItems, inMultiselect: true, activeItem: item })
		this.rangeSelectionAnchorItem = item
	}

	selectPrevious(multiselect: boolean) {
		const oldActiveItem = this.rawState.activeItem
		const newActiveItem = this.getPreviousItem(this.state.items, oldActiveItem)

		if (newActiveItem != null) {
			if (!multiselect) {
				this.onSingleSelection(newActiveItem)
			} else {
				const selectedItems = new Set(this.state.selectedItems)
				this.rangeSelectionAnchorItem = this.rangeSelectionAnchorItem ?? first(this.state.items)
				if (!this.rangeSelectionAnchorItem) return

				const previousActiveIndex = this.state.activeIndex ?? 0
				const towardsAnchor = this.config.sortCompare(oldActiveItem ?? getFirstOrThrow(this.state.items), this.rangeSelectionAnchorItem) > 0
				if (towardsAnchor) {
					// remove
					selectedItems.delete(this.state.items[previousActiveIndex])
				} else {
					// add
					selectedItems.add(newActiveItem)
				}

				this.updateState({ activeItem: newActiveItem, selectedItems, inMultiselect: true })
			}
		}
	}

	private getPreviousItem(items: readonly ItemType[], oldActiveItem: ItemType | null) {
		return oldActiveItem == null ? first(items) : (findLast(items, (item) => this.config.sortCompare(item, oldActiveItem) < 0) ?? first(items))
	}

	selectNext(multiselect: boolean) {
		const oldActiveItem = this.rawState.activeItem
		const lastItem = last(this.state.items)
		const newActiveItem = this.getNextItem(this.state.items, oldActiveItem, lastItem)

		if (newActiveItem != null) {
			if (!multiselect) {
				this.onSingleSelection(newActiveItem)
			} else {
				const selectedItems = new Set(this.state.selectedItems)
				this.rangeSelectionAnchorItem = this.rangeSelectionAnchorItem ?? first(this.state.items)
				if (!this.rangeSelectionAnchorItem) return

				const previousActiveIndex = this.state.activeIndex ?? 0
				const towardsAnchor = this.config.sortCompare(oldActiveItem ?? getFirstOrThrow(this.state.items), this.rangeSelectionAnchorItem) < 0
				if (towardsAnchor) {
					selectedItems.delete(this.state.items[previousActiveIndex])
				} else {
					selectedItems.add(newActiveItem)
				}
				this.updateState({ selectedItems, inMultiselect: true, activeItem: newActiveItem })
			}
		}
	}

	private getNextItem(items: readonly ItemType[], oldActiveItem: ItemType | null, lastItem: ItemType | null | undefined) {
		return oldActiveItem == null
			? first(items)
			: lastItem && this.config.sortCompare(lastItem, oldActiveItem) <= 0
				? lastItem
				: (items.find((item) => this.config.sortCompare(item, oldActiveItem) > 0) ?? first(items))
	}

	areAllSelected(): boolean {
		return this.rawState.inMultiselect && this.state.selectedItems.size === this.state.items.length
	}

	selectAll() {
		this.updateState({ selectedItems: new Set(this.state.items), activeItem: null, inMultiselect: true })
		this.rangeSelectionAnchorItem = null
	}

	selectNone() {
		this.rangeSelectionAnchorItem = null
		this.updateState({ selectedItems: new Set<ItemType>(), inMultiselect: false })
	}

	isItemSelected(itemId: IdType): boolean {
		return findBy(this.state.selectedItems, (item: ItemType) => this.config.isSameId(this.config.getItemId(item), itemId)) != null
	}

	readonly getSelectedAsArray: () => Array<ItemType> = memoizedWithHiddenArgument(
		() => this.state,
		(state: ListState<ItemType>) => [...state.selectedItems],
	)

	readonly isSelectionEmpty: () => boolean = memoizedWithHiddenArgument(
		() => this.state,
		(state: ListState<ItemType>) => state.selectedItems.size === 0,
	)

	readonly getUnfilteredAsArray: () => Array<ItemType> = memoizedWithHiddenArgument(
		() => this.rawState,
		(state: PrivateListState<ItemType>) => [...state.unfilteredItems],
	)

	enterMultiselect() {
		// avoid having the viewed item as a preselected one which might be confusing.
		this.selectNone()
		this.updateState({ inMultiselect: true })
	}

	sort() {
		const filteredItems = this.rawState.filteredItems.slice().sort(this.config.sortCompare)
		const unfilteredItems = this.rawState.unfilteredItems.slice().sort(this.config.sortCompare)
		this.updateState({ filteredItems, unfilteredItems })
	}

	isLoadedCompletely(): boolean {
		return this.rawState.loadingStatus === ListLoadingState.Done
	}

	cancelLoadAll() {
		if (this.state.loadingAll) {
			this.updateState({ loadingAll: false })
		}
	}

	async loadAll() {
		if (this.rawState.loadingAll) return

		this.updateState({ loadingAll: true })

		try {
			while (this.rawState.loadingAll && !this.isLoadedCompletely()) {
				await this.loadMore()
				this.selectAll()
			}
		} finally {
			this.cancelLoadAll()
		}
	}

	isEmptyAndDone(): boolean {
		return this.state.items.length === 0 && this.state.loadingStatus === ListLoadingState.Done
	}

	stopLoading() {
		if (this.state.loadingStatus === ListLoadingState.Loading) {
			// We can't really cancel ongoing requests, but we can prevent more requests from happening
			this.updateState({ loadingStatus: ListLoadingState.ConnectionLost })
		}
	}

	waitLoad(what: () => any): Promise<any> {
		return settledThen(this.loading, what)
	}

	insertLoadedItem(item: ItemType) {
		if (this.rawState.unfilteredItems.some((unfilteredItem) => this.hasSameId(unfilteredItem, item))) {
			return
		}

		// can we do something like binary search?
		const unfilteredItems = this.rawState.unfilteredItems.concat(item).sort(this.config.sortCompare)
		const filteredItems = this.rawState.filteredItems.concat(this.applyFilter([item])).sort(this.config.sortCompare)
		this.updateState({ filteredItems, unfilteredItems })
	}

	updateLoadedItem(item: ItemType) {
		// We cannot use binary search here because the sort order of items can change based on an entity update, and we need to find the position of the
		// old entity by id in order to remove it.

		// Since every item id is unique and there's no scenario where the same item appears twice but in different lists, we can safely sort just
		// by the item id, ignoring the list id

		// update unfiltered list: find the position, take out the old item and put the updated one
		const positionToUpdateUnfiltered = this.rawState.unfilteredItems.findIndex((unfilteredItem) => this.hasSameId(unfilteredItem, item))
		const unfilteredItems = this.rawState.unfilteredItems.slice()
		if (positionToUpdateUnfiltered >= 0) {
			unfilteredItems.splice(positionToUpdateUnfiltered, 1, item)
			unfilteredItems.sort(this.config.sortCompare)
		}

		// update filtered list & selected items
		const positionToUpdateFiltered = this.rawState.filteredItems.findIndex((filteredItem) => this.hasSameId(filteredItem, item))
		const filteredItems = this.rawState.filteredItems.slice()
		const selectedItems = new Set(this.rawState.selectedItems)
		if (positionToUpdateFiltered >= 0) {
			const [oldItem] = filteredItems.splice(positionToUpdateFiltered, 1, item)
			filteredItems.sort(this.config.sortCompare)
			if (selectedItems.delete(oldItem)) {
				selectedItems.add(item)
			}
		}

		// keep active item up-to-date
		const activeItemUpdated = this.rawState.activeItem != null && this.hasSameId(this.rawState.activeItem, item)
		const newActiveItem = this.rawState.activeItem

		if (positionToUpdateUnfiltered !== -1 || positionToUpdateFiltered !== -1 || activeItemUpdated) {
			this.updateState({ unfilteredItems, filteredItems, selectedItems, activeItem: newActiveItem })
		}

		// keep anchor up-to-date
		if (this.rangeSelectionAnchorItem != null && this.hasSameId(this.rangeSelectionAnchorItem, item)) {
			this.rangeSelectionAnchorItem = item
		}
	}

	/**
	 * Remove the item from the list. Will update the selection according to the
	 * {@link ListModelConfig#autoSelectBehavior}.
	 */
	deleteLoadedItem(itemId: IdType): Promise<void> {
		return settledThen(this.loading, () => {
			const item = this.rawState.filteredItems.find((e) => this.config.isSameId(this.config.getItemId(e), itemId))

			const selectedItems = new Set(this.rawState.selectedItems)

			let newActiveItem

			if (item) {
				const wasRemoved = selectedItems.delete(item)

				const shouldSelectANewItem = this.rawState.filteredItems.length > 1

				const filteredItems = this.rawState.filteredItems.slice()
				remove(filteredItems, item)
				const unfilteredItems = this.rawState.unfilteredItems.slice()
				remove(unfilteredItems, item)

				if (shouldSelectANewItem) {
					const desiredBehavior = this.config.autoSelectBehavior?.() ?? null
					if (wasRemoved) {
						if (desiredBehavior === ListAutoSelectBehavior.NONE || this.state.inMultiselect) {
							selectedItems.clear()
						} else if (desiredBehavior === ListAutoSelectBehavior.NEWER) {
							newActiveItem = this.getPreviousItem(filteredItems, item)
						} else {
							newActiveItem =
								item === last(this.state.items) ? this.getPreviousItem(filteredItems, item) : this.getNextItem(filteredItems, item, null)
						}
					}

					if (newActiveItem) {
						selectedItems.add(newActiveItem)
					} else {
						newActiveItem = this.rawState.activeItem
					}
				}
				this.updateState({ filteredItems, selectedItems, unfilteredItems, activeItem: newActiveItem })
			}
		})
	}

	getLastItem(): ItemType | null {
		if (this.rawState.unfilteredItems.length > 0) {
			return lastThrow(this.rawState.unfilteredItems)
		} else {
			return null
		}
	}

	private hasSameId(item1: ItemType, item2: ItemType): boolean {
		const id1 = this.config.getItemId(item1)
		const id2 = this.config.getItemId(item2)
		return this.config.isSameId(id1, id2)
	}

	canInsertItem(entity: ItemType): boolean {
		if (this.state.loadingStatus === ListLoadingState.Done) {
			// If the entire list is loaded, it is always safe to add items, because we can assume we have the entire
			// range loaded
			return true
		}

		// new element is in the loaded range or newer than the first element
		const lastElement = this.getLastItem()
		return lastElement != null && this.config.sortCompare(entity, lastElement) < 0
	}
}

export function selectionAttrsForList<ItemType, IdType>(listModel: Pick<ListModel<ItemType, IdType>, "areAllSelected" | "selectNone" | "selectAll"> | null) {
	return {
		selected: listModel?.areAllSelected() ?? false,
		selectNone: () => listModel?.selectNone(),
		selectAll: () => listModel?.selectAll(),
	}
}
