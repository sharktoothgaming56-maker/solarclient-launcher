const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  // Static, so the About panel does not need an IPC round trip for it.
  runtimeVersions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  // window chrome
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),

  // auth / accounts
  login: () => ipcRenderer.invoke('auth:login'),
  listAccounts: () => ipcRenderer.invoke('auth:list'),
  currentAccount: () => ipcRenderer.invoke('auth:current'),
  switchAccount: (id) => ipcRenderer.invoke('auth:switch', { id }),
  removeAccount: (id) => ipcRenderer.invoke('auth:remove', { id }),

  // instances
  listInstances: () => ipcRenderer.invoke('instances:list'),
  createInstance: (data) => ipcRenderer.invoke('instances:create', data),
  deleteInstance: (data) => ipcRenderer.invoke('instances:delete', data),
  listInstalledMods: (data) => ipcRenderer.invoke('instances:listMods', data),
  listInstalledResourcePacks: (data) => ipcRenderer.invoke('instances:listResourcePacks', data),
  toggleMod: (data) => ipcRenderer.invoke('instances:toggleMod', data),
  deleteMod: (data) => ipcRenderer.invoke('mods:delete', data),
  importModPaths: (data) => ipcRenderer.invoke('mods:importPaths', data),

  // minecraft versions
  listVersions: () => ipcRenderer.invoke('versions:list'),
  listVersionsGrouped: () => ipcRenderer.invoke('versions:grouped'),

  // mods
  searchMods: (data) => ipcRenderer.invoke('mods:search', data),
  modVersions: (data) => ipcRenderer.invoke('mods:versions', data),
  installMod: (data) => ipcRenderer.invoke('mods:install', data),
  importModFile: (data) => ipcRenderer.invoke('mods:importFile', data),
  modpackInstall: (data) => ipcRenderer.invoke('modpacks:install', data),
  modpackImport: (data) => ipcRenderer.invoke('modpacks:import', data),
  modpackExport: (data) => ipcRenderer.invoke('modpacks:export', data),
  openDefaultModsFolder: () => ipcRenderer.invoke('settings:openDefaultModsFolder'),
  // friends
  lookupPlayer: (d) => ipcRenderer.invoke('players:lookup', d),
  friendsSnapshot: () => ipcRenderer.invoke('friends:snapshot'),
  friendsFollow: (d) => ipcRenderer.invoke('friends:follow', d),
  friendsUnfollow: (d) => ipcRenderer.invoke('friends:unfollow', d),
  friendsBlock: (d) => ipcRenderer.invoke('friends:block', d),
  friendsUnblock: (d) => ipcRenderer.invoke('friends:unblock', d),
  friendsSendDm: (d) => ipcRenderer.invoke('friends:sendDm', d),
  friendsEditMessage: (d) => ipcRenderer.invoke('friends:editMessage', d),
  friendsDeleteMessage: (d) => ipcRenderer.invoke('friends:deleteMessage', d),
  friendsClearConversation: (d) => ipcRenderer.invoke('friends:clearConversation', d),
  friendsCreateGroup: (d) => ipcRenderer.invoke('friends:createGroup', d),
  friendsSetGroupIcon: (d) => ipcRenderer.invoke('friends:setGroupIcon', d),
  friendsRemoveFromGroup: (d) => ipcRenderer.invoke('friends:removeFromGroup', d),
  friendsAddToGroup: (d) => ipcRenderer.invoke('friends:addToGroup', d),
  friendsLeaveGroup: (d) => ipcRenderer.invoke('friends:leaveGroup', d),
  friendsSendGroupMessage: (d) => ipcRenderer.invoke('friends:sendGroupMessage', d),
  friendsMarkRead: (d) => ipcRenderer.invoke('friends:markRead', d),
  friendsSendInvite: (d) => ipcRenderer.invoke('friends:sendInvite', d),
  friendsJoinInvite: (d) => ipcRenderer.invoke('friends:joinInvite', d),
  communitiesCreate: (d) => ipcRenderer.invoke('communities:create', d),
  communitiesJoin: (d) => ipcRenderer.invoke('communities:join', d),
  communitiesAddChannel: (d) => ipcRenderer.invoke('communities:addChannel', d),
  communitiesRenameChannel: (d) => ipcRenderer.invoke('communities:renameChannel', d),
  communitiesUpdate: (d) => ipcRenderer.invoke('communities:update', d),
  profileGet: (d) => ipcRenderer.invoke('profile:get', d),
  profileMeta: () => ipcRenderer.invoke('profile:meta'),
  profileSetMeta: (d) => ipcRenderer.invoke('profile:setMeta', d),
  communitiesDeleteChannel: (d) => ipcRenderer.invoke('communities:deleteChannel', d),
  communitiesSetLayout: (d) => ipcRenderer.invoke('communities:setLayout', d),
  communitiesLeave: (d) => ipcRenderer.invoke('communities:leave', d),
  communitiesSend: (d) => ipcRenderer.invoke('communities:send', d),
  voiceJoin: (d) => ipcRenderer.invoke('voice:join', d),
  voiceLeave: () => ipcRenderer.invoke('voice:leave'),
  voiceState: (d) => ipcRenderer.invoke('voice:state', d),
  voiceRnnoise: () => ipcRenderer.invoke('voice:rnnoise'),
  voiceAudio: (frame) => ipcRenderer.send('voice:audio', frame),
  voiceSignal: (frame) => ipcRenderer.invoke('voice:signal', frame),
  mediaSources: () => ipcRenderer.invoke('media:sources'),
  mediaPick: (d) => ipcRenderer.invoke('media:pick', d),
  callAttention: (d) => ipcRenderer.invoke('call:attention', d),
  onVoiceEvent: (cb) => ipcRenderer.on('voice:event', (_e, m) => cb(m)),

  // servers
  serverPing: (d) => ipcRenderer.invoke('servers:ping', d),
  serversSnapshot: () => ipcRenderer.invoke('servers:snapshot'),
  serversCreate: (d) => ipcRenderer.invoke('servers:create', d),
  serversUpdate: (d) => ipcRenderer.invoke('servers:update', d),
  serversRemove: (d) => ipcRenderer.invoke('servers:remove', d),
  serversDeleteFiles: (d) => ipcRenderer.invoke('servers:deleteFiles', d),
  serversAcceptEula: (d) => ipcRenderer.invoke('servers:acceptEula', d),
  serversStart: (d) => ipcRenderer.invoke('servers:start', d),
  serversStop: (d) => ipcRenderer.invoke('servers:stop', d),
  serversCommand: (d) => ipcRenderer.invoke('servers:command', d),
  serversLogs: (d) => ipcRenderer.invoke('servers:logs', d),
  onServersChanged: (cb) => ipcRenderer.on('servers:changed', (_e, p) => cb(p)),
  onServersLog: (cb) => ipcRenderer.on('servers:log', (_e, p) => cb(p)),
  onServersProgress: (cb) => ipcRenderer.on('servers:progress', (_e, p) => cb(p)),
  friendsSetSetting: (d) => ipcRenderer.invoke('friends:setSetting', d),
  friendsReconnect: () => ipcRenderer.invoke('friends:reconnect'),
  friendsWake: () => ipcRenderer.invoke('friends:wake'),
  onFriendsChanged: (cb) => ipcRenderer.on('friends:changed', (_e, p) => cb(p)),
  onFriendsNotify: (cb) => ipcRenderer.on('friends:notify', (_e, p) => cb(p)),
  onFriendsConnection: (cb) => ipcRenderer.on('friends:connection', (_e, p) => cb(p)),
  chatState: () => ipcRenderer.invoke('chat:state'),
  chatEnsure: () => ipcRenderer.invoke('chat:ensure'),
  chatSend: (d) => ipcRenderer.invoke('chat:send', d),
  chatDelete: (d) => ipcRenderer.invoke('chat:delete', d),
  chatPresence: (open) => ipcRenderer.invoke('chat:presence', { open }),
  onlineList: () => ipcRenderer.invoke('online:list'),
  onChatGlobal: (cb) => ipcRenderer.on('chat:global', (_e, p) => cb(p)),
  onFriendsBlocked: (cb) => ipcRenderer.on('friends:blocked', (_e, p) => cb(p)),
  banState: () => ipcRenderer.invoke('ban:state'),
  banRecheck: () => ipcRenderer.invoke('ban:recheck'),
  onBanState: (cb) => ipcRenderer.on('ban:state', (_e, p) => cb(p)),
  modAccess: () => ipcRenderer.invoke('mod:access'),
  modRequest: (d) => ipcRenderer.invoke('mod:request', d),
  onModEvent: (cb) => ipcRenderer.on('mod:event', (_e, p) => cb(p)),
  onPopoutHover: (cb) => ipcRenderer.on('popout:hover', (_e, p) => cb(p)),
  onPopoutDock: (cb) => ipcRenderer.on('popout:dock', (_e, p) => cb(p)),
  popoutGrab: (p) => ipcRenderer.send('popout:grab', p),
  popoutRelease: () => ipcRenderer.send('popout:release'),
  modFile: (d) => ipcRenderer.invoke('mod:file', d),
  reportSend: (d) => ipcRenderer.invoke('report:send', d),

  loaderGameVersions: (loader) => ipcRenderer.invoke('loaders:gameVersions', loader),
  // skins
  skinsList: () => ipcRenderer.invoke('skins:list'),
  skinsImport: () => ipcRenderer.invoke('skins:import'),
  skinsSaveDataUrl: (data) => ipcRenderer.invoke('skins:saveDataUrl', data),
  skinsRename: (data) => ipcRenderer.invoke('skins:rename', data),
  skinsDelete: (data) => ipcRenderer.invoke('skins:delete', data),
  skinsCurrent: (data) => ipcRenderer.invoke('skins:current', data || {}),
  skinTextureFor: (uuid) => ipcRenderer.invoke('skins:textureFor', { uuid }),
  skinsApply: (data) => ipcRenderer.invoke('skins:apply', data),

  syncPreview: (data) => ipcRenderer.invoke('instances:syncPreview', data),
  syncInstances: (data) => ipcRenderer.invoke('instances:sync', data),
  onSyncProgress: (cb) => ipcRenderer.on('sync:progress', (_e, p) => cb(p)),
  onMainError: (cb) => ipcRenderer.on('main:error', (_e, p) => cb(p)),

  // resource pack auto-install
  resourcePackSettings: () => ipcRenderer.invoke('resourcepack:settings'),
  setAutoInstallResourcePack: (enabled) => ipcRenderer.invoke('resourcepack:setEnabled', { enabled }),

  // launch
  launchGame: (data) => ipcRenderer.invoke('launch:start', data),
  stopGame: (launchId) => ipcRenderer.invoke('launch:stop', { launchId }),
  listRunning: () => ipcRenderer.invoke('launch:running'),
  prewarm: (data) => ipcRenderer.invoke('launch:prewarm', data),
  onPrewarmProgress: (cb) => ipcRenderer.on('prewarm:progress', (_e, payload) => cb(payload)),
  setPreload: (args) => ipcRenderer.invoke('preload:set', args),
  onPreloadState: (cb) => ipcRenderer.on('preload:state', (_e, payload) => cb(payload)),
  getLogBuffer: (launchId) => ipcRenderer.invoke('launch:logBuffer', { launchId }),
  onStats: (cb) => ipcRenderer.on('launch:stats', (_e, payload) => cb(payload)),
  openMonitor: (launchId) => ipcRenderer.invoke('monitor:open', { launchId }),

  // performance + hardware
  systemInfo: () => ipcRenderer.invoke('system:info'),
  applyBestSettings: (data) => ipcRenderer.invoke('perf:applyBestSettings', data),
  readSettings: (data) => ipcRenderer.invoke('perf:readSettings', data),
  getPerfProfile: (data) => ipcRenderer.invoke('perf:getProfile', data),
  setPerfProfile: (data) => ipcRenderer.invoke('perf:setProfile', data),
  tuneMods: (data) => ipcRenderer.invoke('perf:tuneMods', data),
  getPlaytime: () => ipcRenderer.invoke('stats:playtime'),

  // bedrock edition
  detectBedrock: () => ipcRenderer.invoke('bedrock:detect'),
  launchBedrock: (data) => ipcRenderer.invoke('bedrock:launch', data || {}),
  openBedrockStore: () => ipcRenderer.invoke('bedrock:openStore'),

  // discord rich presence
  discordSettings: () => ipcRenderer.invoke('discord:settings'),
  setDiscordEnabled: (enabled) => ipcRenderer.invoke('discord:setEnabled', { enabled }),
  setDiscordShowDetails: (showDetails) => ipcRenderer.invoke('discord:setShowDetails', { showDetails }),
  setDiscordAppId: (appId) => ipcRenderer.invoke('discord:setAppId', { appId }),
  testDiscord: () => ipcRenderer.invoke('discord:test'),
  onDiscordState: (cb) => ipcRenderer.on('discord:state', (_e, payload) => cb(payload)),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),

  // auto-updater (VPS-mediated)
  getUpdateState: () => ipcRenderer.invoke('update:getState'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: (which) => ipcRenderer.invoke('update:download', which),
  dismissUpdate: () => ipcRenderer.invoke('update:dismiss'),
  switchToStable: () => ipcRenderer.invoke('update:switchStable'),
  listBetas: (force) => ipcRenderer.invoke('update:listBetas', Boolean(force)),
  installBeta: (version) => ipcRenderer.invoke('update:installBeta', version),
  restartToApplyUpdate: () => ipcRenderer.invoke('update:restart'),
  onUpdateState: (cb) => ipcRenderer.on('update:state', (_e, state) => cb(state)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, pct) => cb(pct)),

  // customize
  pickBackgroundImage: () => ipcRenderer.invoke('customize:pickBackground'),
  getOnlineCount: () => ipcRenderer.invoke('online:count'),
  onThemeChanged: (cb) => ipcRenderer.on('theme:changed', (_e, payload) => cb(payload)),
  notifyThemeChanged: () => ipcRenderer.invoke('theme:notify'),
  // The main process now ships log lines in per-tick batches instead of one
  // IPC message per line (see IPC COALESCING in main.js). Unpacking here
  // keeps every existing onLog(({launchId, line, level}) => ...) caller
  // working unchanged, while the expensive part -- the process hop -- has
  // already been paid once for the whole batch instead of once per line.
  onLog: (cb) => {
    ipcRenderer.on('launch:log', (_e, payload) => cb(payload));
    ipcRenderer.on('launch:log-batch', (_e, { launchId, lines }) => {
      for (let i = 0; i < lines.length; i++) {
        cb({ launchId, line: lines[i].line, level: lines[i].level });
      }
    });
  },
  // Batch-aware consumers can take the whole array in one call and do a
  // single DOM write for it -- see flushLines() in monitor.js.
  onLogBatch: (cb) => ipcRenderer.on('launch:log-batch', (_e, payload) => cb(payload)),
  onStarted: (cb) => ipcRenderer.on('launch:started', (_e, payload) => cb(payload)),
  onClosed: (cb) => ipcRenderer.on('launch:closed', (_e, payload) => cb(payload)),
  onGameMode: (cb) => ipcRenderer.on('game:mode', (_e, payload) => cb(payload)),
  getGameMode: () => ipcRenderer.invoke('game:mode'),
  onProgress: (cb) => ipcRenderer.on('launch:progress', (_e, payload) => cb(payload)),
  onCrashSuggestion: (cb) => ipcRenderer.on('launch:crash-suggestion', (_e, payload) => cb(payload)),
  onModProgress: (cb) => ipcRenderer.on('mods:progress', (_e, payload) => cb(payload)),
  onModpackProgress: (cb) => ipcRenderer.on('modpacks:progress', (_e, payload) => cb(payload)),

  // one-click Java repair (offered from the crash banner)
  fixJava: (javaMajor) => ipcRenderer.invoke('crash:fixJava', { javaMajor }),
  onFixProgress: (cb) => ipcRenderer.on('fix:progress', (_e, payload) => cb(payload)),

  // crash auto-fix dialog
  onCrashAnalysis: (cb) => ipcRenderer.on('launch:crash-analysis', (_e, payload) => cb(payload)),
  applyCrashFixes: (launchId, ids) => ipcRenderer.invoke('crash:applyFixes', { launchId, ids }),
  openCrashReport: (launchId) => ipcRenderer.invoke('crash:openReport', { launchId }),
  crashDialogClosed: () => ipcRenderer.invoke('crash:dialogClosed'),

  // AFK sessions
  afkList: () => ipcRenderer.invoke('afk:list'),
  afkSave: (data) => ipcRenderer.invoke('afk:save', data),
  afkDelete: (data) => ipcRenderer.invoke('afk:delete', data),
  afkStart: (data) => ipcRenderer.invoke('afk:start', data),
  afkStop: (data) => ipcRenderer.invoke('afk:stop', data),
  onAfkStatus: (cb) => ipcRenderer.on('afk:status', (_e, payload) => cb(payload)),
  onAfkDisconnected: (cb) => ipcRenderer.on('afk:disconnected', (_e, payload) => cb(payload)),

  // level / xp
  xpGet: () => ipcRenderer.invoke('xp:get'),
  leaderboard: () => ipcRenderer.invoke('leaderboard:list'),
  cosmeticsGet: () => ipcRenderer.invoke('cosmetics:get'),
  cosmeticsEquip: (slot, id) => ipcRenderer.invoke('cosmetics:equip', { slot, id }),
  xpAdd: (amount) => ipcRenderer.invoke('xp:add', amount),
  onXpChanged: (cb) => ipcRenderer.on('xp:changed', (_e, payload) => cb(payload)),
  fetchImageBase64: (url) => ipcRenderer.invoke('util:fetchImageBase64', url),
};

contextBridge.exposeInMainWorld('solar', api);
contextBridge.exposeInMainWorld('nebula', api);
