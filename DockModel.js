// The dock's state that does not need Quickshell: where it sits, which apps it
// shows, and which window a click brings forward.

var POSITIONS = ["top", "bottom", "left", "right"]

function normalizePosition(value) {
  var position = String(value || "").trim().toLowerCase()
  return POSITIONS.indexOf(position) >= 0 ? position : "bottom"
}

function isVertical(position) {
  var normalized = normalizePosition(position)
  return normalized === "left" || normalized === "right"
}

function normalizeId(value) {
  var id = String(value || "").trim()
  if (id.slice(-8) === ".desktop") id = id.slice(0, -8)
  return id
}

function pinnedIds(dockConfig, defaultsConfig) {
  var source = dockConfig && Array.isArray(dockConfig.pinned) ? dockConfig.pinned
    : (defaultsConfig && Array.isArray(defaultsConfig.pinned) ? defaultsConfig.pinned : [])
  var ids = []
  for (var i = 0; i < source.length; i++) {
    var id = normalizeId(source[i])
    if (id && ids.indexOf(id) === -1) ids.push(id)
  }
  return ids
}

// Any non-floating window on a regular workspace belongs in the dock, even
// when it has no desktop entry (for example a terminal running an agent).
// Minimized windows remain available for restoring from the dock.
function isDockWindow(window) {
  if (!window || !window.key || window.floating === true) return false
  if (window.minimized === true) return true
  return window.workspaceId >= 1
}

// Minimizing moves a window to this special workspace, and the dock brings it
// back.
var MINIMIZED_WORKSPACE = "special:minimized"

function isMinimizedWorkspace(name) {
  return String(name || "") === MINIMIZED_WORKSPACE
}

// A terminal app's window carries the app id its launcher gave the terminal,
// which no desktop entry names as its class. The entry that passes that app id
// claims it, and so does a terminal entry for the command Omarchy's TUI
// launcher named it after (org.omarchy.nvim for nvim). Entries are
// { id, execString, command, runInTerminal }.
function claimingEntryId(appId, entries) {
  var id = String(appId || "")
  if (!id) return ""
  var list = entries || []
  var flag = "--app-id=" + id
  for (var i = 0; i < list.length; i++) {
    var words = String(list[i].execString || "").split(/\s+/)
    if (words.indexOf(flag) >= 0) return list[i].id
  }
  if (id.indexOf("org.omarchy.") !== 0) return ""
  var command = id.slice("org.omarchy.".length)
  for (var j = 0; j < list.length; j++) {
    var program = String((list[j].command || [])[0] || "")
    if (list[j].runInTerminal && program.slice(program.lastIndexOf("/") + 1) === command) return list[j].id
  }
  return ""
}

// Pinned launchers keep their own slots. Every open window gets a separate
// address-keyed item, including windows from pinned apps.
function buildItems(pinned, windows) {
  var items = []
  var byKey = {}
  var pinSet = {}
  var runningApps = {}

  for (var i = 0; i < (pinned || []).length; i++) {
    var id = pinned[i]
    if (!id || byKey[id]) continue
    pinSet[id] = true
    byKey[id] = { key: id, desktopId: id, pinned: true, appRunning: false, windows: [] }
    items.push(byKey[id])
  }

  for (var j = 0; j < (windows || []).length; j++) {
    var window = windows[j]
    if (!isDockWindow(window)) continue

    var appId = window.desktopId || window.key
    var key = window.key
    if (!key || byKey[key]) continue
    runningApps[appId] = true
    byKey[key] = { key: key, desktopId: appId, pinned: pinSet[appId] === true, windows: [window] }
    items.push(byKey[key])
  }

  for (var k = 0; k < (pinned || []).length; k++) {
    var launcher = byKey[pinned[k]]
    if (launcher) launcher.appRunning = runningApps[pinned[k]] === true
  }

  return items
}

// Unopened pinned apps stay in pin order. Running windows follow the active
// workspace's screen order: left-to-right for a horizontal dock, top-to-bottom
// for a vertical one.
function orderItems(items, order, dockPosition, activeWorkspaceId) {
  var launchers = []
  var windows = []
  var vertical = isVertical(dockPosition)

  for (var i = 0; i < (items || []).length; i++) {
    var item = items[i]
    if (item.windows && item.windows.length > 0) windows.push(item)
    else launchers.push(item)
  }

  windows.sort(function(a, b) {
    var aw = a.windows[0] || {}
    var bw = b.windows[0] || {}
    var aCurrent = aw.workspaceId === activeWorkspaceId
    var bCurrent = bw.workspaceId === activeWorkspaceId
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1
    if (aw.workspaceId !== bw.workspaceId) return aw.workspaceId - bw.workspaceId

    var ap = aw.position || {}
    var bp = bw.position || {}
    var aAxis = Number(vertical ? ap.y : ap.x) || 0
    var bAxis = Number(vertical ? bp.y : bp.x) || 0
    if (aAxis !== bAxis) return aAxis - bAxis
    return String(a.key).localeCompare(String(b.key))
  })

  return launchers.concat(windows)
}

// The order with key moved to index, counted once key has left its old slot.
function orderWithKeyAt(order, key, index) {
  var keys = (order || []).filter(function(other) { return other !== key })
  keys.splice(Math.max(0, Math.min(keys.length, index)), 0, key)
  return keys
}

// Where a dragged icon lands: its own slot moved by however many slots the
// pointer has travelled, kept within the dock.
function dropIndex(fromIndex, offset, slotSize, count) {
  if (count <= 0 || !(slotSize > 0)) return fromIndex
  var target = fromIndex + Math.round(offset / slotSize)
  return Math.max(0, Math.min(count - 1, target))
}

// The pins to save for the dock's order: the pinned apps in that order, then
// pins the dock is not showing, because their app is not installed, as they
// were. pinned holds the pinned desktop ids as keys.
function pinsInOrder(order, pinned, allPinned) {
  var result = (order || []).filter(function(key) { return pinned[key] === true })
  for (var i = 0; i < (allPinned || []).length; i++) {
    if (result.indexOf(allPinned[i]) === -1 && (order || []).indexOf(allPinned[i]) === -1) result.push(allPinned[i])
  }
  return result
}

// The window a click on an app brings forward. Windows on the workspace in
// front of the user come first, then minimized ones, which come back to it,
// and only then those on other workspaces. Clicking again while one of them
// is focused moves on to the next in that order. Windows are
// { workspaceId, minimized, activated }.
function pickWindow(windows, workspaceId) {
  var list = windows || []
  if (list.length === 0) return -1

  function rank(window) {
    if (window.minimized) return 1
    return window.workspaceId === workspaceId ? 0 : 2
  }

  var order = list.map(function(window, index) { return index })
  order.sort(function(a, b) { return rank(list[a]) - rank(list[b]) || a - b })

  for (var i = 0; i < order.length; i++) {
    if (list[order[i]].activated) return order[(i + 1) % order.length]
  }
  return order[0]
}


if (typeof module !== "undefined") {
  module.exports = {
    normalizePosition: normalizePosition,
    isVertical: isVertical,
    normalizeId: normalizeId,
    pinnedIds: pinnedIds,
    isDockWindow: isDockWindow,
    isMinimizedWorkspace: isMinimizedWorkspace,
    claimingEntryId: claimingEntryId,
    buildItems: buildItems,
    orderItems: orderItems,
    orderWithKeyAt: orderWithKeyAt,
    dropIndex: dropIndex,
    pinsInOrder: pinsInOrder,
    pickWindow: pickWindow
  }
}
