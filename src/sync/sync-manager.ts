/**
 * astra side wiring for the vendored OneDrive sync engine
 *
 * Owns: settings access, the internal DB + vaultRandomID lifecycle, the
 * remote client, vault delete/rename history recording, auto-sync timers,
 * the Device Code Flow auth orchestration, and sync status notifications.
 *
 * OAuth 鉴权不再依赖 obsidian:// URL scheme —— 改用 Device Code Flow
 *（RFC 8628），一条代码路径通吃桌面/iOS/Android。
 */

import type {
  App,
  EventRef,
  TAbstractFile} from "obsidian";
import {
  Modal,
  Notice,
  Platform,
  Setting,
  TFile,
  normalizePath,
  setIcon,
} from "obsidian";
import type AstraDashboardPlugin from "../main";
import { t as $t } from "../i18n";
import type {
  ConflictActionType,
  SyncDirectionType,
  SyncTriggerSourceType,
} from "./baseTypes";
import { applyRemoteSnapshotMigration } from "./baseTypes";
import {
	buildDeviceCodeFlowClient,
	humanizeApiError,
} from "./remoteForOnedrive";
import { RemoteClient } from "./remote";
import {
  remoteSnapshotClear,
  remoteSnapshotSaveAll
} from "./idb";
import type { InternalDBs } from "./localdb";
import {
  clearAllPrevSyncRecordsByVault,
  insertDeleteRecordByVault,
  insertRenameRecordByVault,
  loadPrevSyncRecordsByVault,
  prepareDBs,
} from "./localdb";
import { listFilesInObsFolder } from "./obsFolderLister";
import { TokenStorage } from "./onedrive/auth/tokenStorage";
import type { DeviceCodeResponse } from "./onedrive/auth/deviceCodeFlow";
import {
  isPasswordOk,
  getRemoteStates,
  getSyncPlanV3,
  doActualSyncV3,
  type SyncStatusType,
} from "./syncEngine";
import { SyncAutoScheduler, type AutoSyncSource } from "./syncScheduler";
import { composeStatusBarProgress, parseProgressMessage } from "./statusBarText";
import { setSyncDebugEnabled, syncLog } from "./log";

/** 同步运行中需要实时显示到状态栏的步骤（→ i18n 键） */
const SYNC_STATUS_STEP_KEYS: Partial<Record<SyncStatusType, string>> = {
  getting_remote_files_list: "sync.progress.getting_remote_files_list",
  checking_password: "sync.progress.checking_password",
  getting_remote_extra_meta: "sync.progress.getting_remote_extra_meta",
  getting_local_meta: "sync.progress.getting_local_meta",
  generating_plan: "sync.progress.generating_plan",
  syncing: "sync.progress.syncing",
};

/** 上次成功同步的相对时间文案（移植自上游 misc.ts getLastSynced 的分级） */
function formatLastSyncedRelative(ms: number): { msg: string; label: string } {
  const deltaTime = Date.now() - ms;
  const years = Math.floor(deltaTime / 31556952000);
  const months = Math.floor(deltaTime / 2629746000);
  const weeks = Math.floor(deltaTime / 604800000);
  const days = Math.floor(deltaTime / 86400000);
  const hours = Math.floor(deltaTime / 3600000);
  const minutes = Math.floor(deltaTime / 60000);
  let timeText: string;
  if (years > 0) {
    timeText = $t("sync.statusbar.years", { time: years });
  } else if (months > 0) {
    timeText = $t("sync.statusbar.months", { time: months });
  } else if (weeks > 0) {
    timeText = $t("sync.statusbar.weeks", { time: weeks });
  } else if (days > 0) {
    timeText = $t("sync.statusbar.days", { time: days });
  } else if (hours > 0) {
    timeText = $t("sync.statusbar.hours", { time: hours });
  } else if (minutes > 0) {
    timeText = $t("sync.statusbar.minutes", { time: minutes });
  } else {
    timeText = $t("sync.statusbar.lessminute");
  }

  // aria-label 用完整日期时间（对齐上游 statusbar_lastsync_label）
  const dateText = new Date(ms).toLocaleTimeString(navigator.language, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return {
    msg: $t("sync.statusbar.lastsync", { time: timeText }),
    label: $t("sync.statusbar.lastsyncLabel", { date: dateText }),
  };
}

export interface SyncStatusInfo {
  status: SyncStatusType;
  /** 人类可读的进度描述（已完成/总数等） */
  message?: string;
  lastError?: string;
}

/** Device Code Flow 授权 Modal —— 展示 user_code + verification_uri + 轮询状态 */
class DeviceCodeAuthModal extends Modal {
	private statusEl: HTMLElement | null = null;
	private retryBtnEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly deviceCodeResp: DeviceCodeResponse,
		private readonly onDone: () => void,
		private readonly onRetry: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: $t("sync.auth.deviceCodeTitle") });
		contentEl.createEl("p", { text: $t("sync.auth.deviceCodeHint") });

		// 设备码：使用 styles.css 里的 .device-code-wrap 样式
		const codeWrap = contentEl.createDiv({ cls: "device-code-wrap" });
		codeWrap.textContent = this.deviceCodeResp.user_code;

		contentEl.createEl("p", { text: $t("sync.auth.openDeviceCodeUrlHint") });
		contentEl.createEl("p").createEl("a", {
			href: this.deviceCodeResp.verification_uri,
			text: this.deviceCodeResp.verification_uri,
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText($t("sync.auth.copyLink"))
					.onClick(() => {
						void navigator.clipboard
							.writeText(this.deviceCodeResp.verification_uri)
							.then(() => new Notice($t("sync.auth.copyLinkNotice")))
							.catch(() => { /* no-op */ });
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText($t("sync.auth.copyUserCode"))
					.onClick(() => {
						void navigator.clipboard
							.writeText(this.deviceCodeResp.user_code)
							.then(() => new Notice($t("sync.auth.copyUserCodeNotice")))
							.catch(() => { /* no-op */ });
					})
			);

		// 轮询状态（初始：等待中）
		this.statusEl = contentEl.createEl("p", {
			cls: "device-code-status",
			text: $t("sync.auth.pollingWaiting"),
		});

		// 重新授权按钮（初始隐藏，失败/过期时显示）
		this.retryBtnEl = contentEl.createEl("p", { cls: "device-code-retry" });
		const btn = this.retryBtnEl.createEl("button", {
			type: "button",
			cls: "mod-cta",
			text: $t("sync.auth.retryButton"),
		});
		btn.addEventListener("click", () => this.onRetry());
		this.retryBtnEl.hide();

		// 桌面端自动打开浏览器
		if (!Platform.isMobileApp) {
			window.open(this.deviceCodeResp.verification_uri);
		}
	}

	/** 成功状态 —— 绿字 + 稍后自动关闭 */
	markSuccess(): void {
		if (!this.statusEl) return;
		this.statusEl.setText($t("sync.auth.pollingSuccess"));
		this.statusEl.addClass("device-code-status-success");
		this.statusEl.removeClass("device-code-status-failed");
		if (this.retryBtnEl) this.retryBtnEl.hide();
	}

	/** 失败状态 —— 红字展示错误 + 显示重试按钮，Modal 保持打开 */
	markFailed(errorMsg: string): void {
		if (!this.statusEl) return;
		this.statusEl.setText(errorMsg);
		this.statusEl.addClass("device-code-status-failed");
		this.statusEl.removeClass("device-code-status-success");
		if (this.retryBtnEl) this.retryBtnEl.show();
	}

	onClose(): void {
		this.contentEl.empty();
		this.statusEl = null;
		this.retryBtnEl = null;
		this.onDone();
	}
}

export class SyncManager {
  private readonly plugin: AstraDashboardPlugin;
  private db: InternalDBs | null = null;
  private vaultRandomID = "";
  private client: RemoteClient | null = null;
  private syncing = false;

  /** Device Code Flow token 存储（Obsidian SecretStorage） */
  private tokenStorage: TokenStorage = new TokenStorage();
  /** 当前 RemoteClient 对应的 (clientID, authority) 指纹 —— 用来检测是否需要重建 */
  private clientFingerprint = "";

  private statusListeners = new Set<(info: SyncStatusInfo) => void>();
  private currentStatus: SyncStatusInfo = { status: "idle" };

  private autoScheduler: SyncAutoScheduler;
  /** 状态栏相对时间刷新定时器（对齐上游 30s interval） */
  private statusBarTimer: number | null = null;
  private statusBarItemEl: HTMLElement | null = null;

  private vaultEventRefs: EventRef[] = [];
  /** 进行中的 Device Code Flow 授权 Modal（用于 cancelPolling） */
  private activeAuthModal: DeviceCodeAuthModal | null = null;

  constructor(plugin: AstraDashboardPlugin) {
    this.plugin = plugin;
    // 统一调度器：自动同步三个来源（启动首次 / 定时 / 保存后）共用一个实现，
    // 同时保证任意两次自动同步之间至少间隔 AUTO_MIN_INTERVAL_MS。
    this.autoScheduler = new SyncAutoScheduler(
      (source: AutoSyncSource) => this.schedulerRunAutoSync(source)
    );
  }

  // ─────────────────────────── lifecycle ───────────────────────────

  async onload(): Promise<void> {
    setSyncDebugEnabled(this.plugin.data.settings.sync.debug ?? false);

    try {
      const r = await prepareDBs(this.plugin.app.vault.getName(), "");
      this.db = r.db;
      this.vaultRandomID = r.vaultRandomID;
    } catch (err) {
      syncLog.error("prepareDBs failed", err);
    }

    // ── 一次性迁移：remoteSnapshot 从 data.json 搬到 IndexedDB ──
    await this.migrateRemoteSnapshotToIDB();

    // ── Device Code Flow 时代：初始化 TokenStorage ──
    // SecretStorage 优先；为空则从 data.json 的旧字段迁入并清空。
    await this.tokenStorage.initialize(
      this.plugin.app,
      this.plugin.data.settings.sync.onedriveConfig,
      async () => {
        const cfg = this.plugin.data.settings.sync.onedriveConfig;
        cfg.accessToken = "";
        cfg.refreshToken = "";
        cfg.accessTokenExpiresAtTime = 0;
        cfg.accessTokenExpiresInSeconds = 0;
        await this.plugin.saveSettings();
      }
    );

    this.applyEnabled();

    // 状态栏相对时间每 30s 刷新（同步中让位于实时步骤显示；对齐上游）
    this.statusBarTimer = window.setInterval(() => {
      if (!this.syncing) {
        this.updateStatusBar();
      }
    }, 30_000);
  }

  onunload(): void {
    this.autoScheduler.stop();
    this.clearTimers();
    this.unregisterVaultEvents();
    this.activeAuthModal?.close();
    this.activeAuthModal = null;
    this.removeStatusBarItem();
  }

  get isReady(): boolean {
    return this.db !== null && this.vaultRandomID !== "";
  }

  get isSyncing(): boolean {
    return this.syncing;
  }

  getStatus(): SyncStatusInfo {
    return this.currentStatus;
  }

  onStatusChange(listener: (info: SyncStatusInfo) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * 一次性迁移：把 settings.sync.onedriveConfig.remoteSnapshot（~367KB）
   * 从 data.json 搬到 IndexedDB 的 dedicated "remoteSnapshot" store。
   * 幂等：标记位 remoteSnapshotMigrated 在 onedriveConfig 上，迁移后写入 data.json；
   *       重复启动时标记已存在，直接跳过。
   * 降级安全：任何 IDB 异常被吞掉，remoteSnapshot 字段保留在 data.json，
   *           不阻塞后续——下次 listFromRemote 会从 IDB 拿到空快照，
   *           走全量枚举，同步功能不受影响。
   */
  private async migrateRemoteSnapshotToIDB(): Promise<void> {
    try {
      const odc = this.plugin.data.settings.sync.onedriveConfig;
      if (!odc) return;
      if (odc.remoteSnapshotMigrated) return;

      const snapshot = odc.remoteSnapshot;
      if (snapshot && Object.keys(snapshot).length > 0) {
        // 先写 IndexedDB，再在内存对象上落迁移标记 + 删字段（由纯函数完成）
        await remoteSnapshotSaveAll(snapshot as Record<string, { key: string }>);
      }

      applyRemoteSnapshotMigration(odc as typeof odc & Record<string, unknown>);
      await this.plugin.saveSettings();

      if (snapshot && Object.keys(snapshot).length > 0) {
        syncLog.info(
          `remoteSnapshot 迁移到 IndexedDB 完成（${Object.keys(snapshot).length} 条路径）`
        );
      }
    } catch (err) {
      syncLog.warn(
        "remoteSnapshot 迁移到 IndexedDB 失败（降级保留在 data.json）",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private setStatus(status: SyncStatusType, message?: string): void {
    this.currentStatus = { ...this.currentStatus, status, message };
    for (const listener of this.statusListeners) {
      listener(this.currentStatus);
    }
    this.updateStatusBarProgress();
  }

  /** 同步运行中：状态栏实时显示当前步骤（结束后由 finally 恢复为上次同步时间） */
  private updateStatusBarProgress(): void {
    const stepKey = SYNC_STATUS_STEP_KEYS[this.currentStatus.status];
    if (!this.syncing || stepKey === undefined) return;
    const el = this.ensureStatusBarItem();
    if (el === null) return;
    let step = $t(stepKey);
    if (this.currentStatus.status === "syncing" && this.currentStatus.message) {
      const parsed = parseProgressMessage(this.currentStatus.message);
      const suffix =
        parsed === undefined
          ? ""
          : $t("sync.statusbar.progress", { pct: parsed.pct });
      step = composeStatusBarProgress(
        step,
        this.currentStatus.message,
        suffix
      );
    }
    const text = $t("sync.status.statusBarProgress", { step });
    el.setText(text);
    // 无障碍标签与可见文案保持一致（步骤名 + 进度）
    el.setAttribute("aria-label", text);
  }

  /** 状态栏元素：仅在同步启用且开启「状态栏显示」时存在 */
  private ensureStatusBarItem(): HTMLElement | null {
    const s = this.plugin.data.settings.sync;
    if (!s.enabled || !s.showStatusBar) {
      this.removeStatusBarItem();
      return null;
    }
    if (this.statusBarItemEl === null) {
      this.statusBarItemEl = this.plugin.addStatusBarItem();
    }
    return this.statusBarItemEl;
  }

  private removeStatusBarItem(): void {
    this.statusBarItemEl?.remove();
    this.statusBarItemEl = null;
  }

  /** 应用 enabled 开关：注册/注销 vault 事件与定时器 */
  applyEnabled(): void {
    const s = this.plugin.data.settings.sync;
    this.autoScheduler.stop();
    this.unregisterVaultEvents();

    if (!s.enabled) {
      this.removeStatusBarItem();
      return;
    }

    // 保存后同步：独立开关，与 autoRunEveryMilliseconds 无关
    // 但：modify handler 本身始终注册（还承担删除/重命名历史记录），
    // 只有 syncOnSaveEnabled 时才投递 onSaveModified() 给调度器。
    this.registerVaultEvents();

    // 自动周期同步 + 启动首次：仅 autoRunEveryMilliseconds > 0 时启动。
    // 周期关闭时不跑启动首次（按用户明确要求的行为矩阵）。
    if (s.autoRunEveryMilliseconds > 0) {
      this.autoScheduler.start(s.autoRunEveryMilliseconds);
    }

    this.updateStatusBar();
  }

  /** 调度器的执行回调（纯内部：被 SyncAutoScheduler 持有） */
  private async schedulerRunAutoSync(source: AutoSyncSource): Promise<void> {
    // syncInProgress 已由 SyncAutoScheduler 外部管理，这里不检查
    await this.syncRun(source, /*silent*/ true);
  }

  /** 状态栏：空闲时显示上次成功同步的相对时间（对齐上游） */
  private updateStatusBar(): void {
    const s = this.plugin.data.settings.sync;
    const el = this.ensureStatusBarItem();
    if (el === null) return;
    if (s.lastSynced === -1) {
      el.setText($t("sync.statusbar.never"));
      el.setAttribute("aria-label", $t("sync.statusbar.neverLabel"));
      return;
    }
    const { msg, label } = formatLastSyncedRelative(s.lastSynced);
    el.setText(msg);
    el.setAttribute("aria-label", label);
  }

  private clearTimers(): void {
    if (this.statusBarTimer !== null) {
      window.clearInterval(this.statusBarTimer);
      this.statusBarTimer = null;
    }
  }

  private registerVaultEvents(): void {
    if (this.vaultEventRefs.length > 0) {
      return;
    }

    // 删除/重命名历史是三向合并的核心输入，必须始终记录
    const deleteRef = this.plugin.app.vault.on("delete", (file) => {
      if (this.db !== null) {
        void insertDeleteRecordByVault(this.db, file, this.vaultRandomID);
      }
    });
    this.vaultEventRefs.push(deleteRef);
    const renameRef = this.plugin.app.vault.on("rename", (file, oldPath) => {
      if (this.db !== null) {
        void insertRenameRecordByVault(
          this.db,
          file,
          oldPath,
          this.vaultRandomID
        );
      }
    });
    this.vaultEventRefs.push(renameRef);

    // 保存后触发自动同步：trailing debounce + minInterval 都由 SyncAutoScheduler 统一处理。
    // 独立布尔开关 syncOnSaveEnabled 控制是否投递——不再依附 autoRunEveryMilliseconds。
    // 构造插件自身数据文件的归一化路径集合，用于排除：
    // saveSettings() 写 data.json、StaticStore 写 static-data.json 都会触发 vault modify，
    // 若不排除会形成「syncRun → saveSettings → modify → syncRun」的反馈环。
    const pluginDir =
      this.plugin.manifest.dir ??
      normalizePath(
        [this.plugin.app.vault.configDir, "plugins", this.plugin.manifest.id].join("/")
      );
    const pluginOwnDataFiles = new Set<string>([
      normalizePath([pluginDir, "data.json"].join("/")),
      normalizePath([pluginDir, "static-data.json"].join("/")),
    ]);

    const modifyRef = this.plugin.app.vault.on("modify", (file: TAbstractFile) => {
      if (!(file instanceof TFile)) return;
      const normalized = normalizePath(file.path);
      if (pluginOwnDataFiles.has(normalized)) return; // 自己的数据文件，跳过
      const s = this.plugin.data.settings.sync;
      if (!s.syncOnSaveEnabled) return; // 保存后同步开关关闭，不投递
      this.autoScheduler.onSaveModified();
    });
    this.vaultEventRefs.push(modifyRef);
  }

  private unregisterVaultEvents(): void {
    for (const ref of this.vaultEventRefs) {
      this.plugin.app.vault.offref(ref);
    }
    this.vaultEventRefs = [];
  }

  // ─────────────────────────── auth ───────────────────────────

  get isAuthorized(): boolean {
    return this.tokenStorage.hasTokens();
  }

  /**
   * Device Code Flow 鉴权：
   * ① 向 Microsoft 请求设备码
   * ② 展示 user_code + verification_uri Modal
   * ③ 用户在浏览器完成授权
   * ④ 插件后台轮询 /token 拿到 token
   * ⑤ 写入 TokenStorage（SecretStorage）
   * ⑥ 拉取 username → 完成
   */
  async startAuth(): Promise<void> {
    const cfg = this.plugin.data.settings.sync.onedriveConfig;
    const flowClient = buildDeviceCodeFlowClient(cfg);

    let deviceCodeResp: DeviceCodeResponse;
    try {
      deviceCodeResp = await flowClient.requestDeviceCode();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      syncLog.error("startAuth: requestDeviceCode failed", err);
      new Notice($t("sync.auth.failed", { msg }));
      return;
    }

    const modal = new DeviceCodeAuthModal(
      this.plugin.app,
      deviceCodeResp,
      () => {
        if (this.activeAuthModal === modal) this.activeAuthModal = null;
      },
      () => {
        // 用户点"重新授权" —— 关旧 Modal → 开新一轮
        modal.close();
        void this.startAuth();
      }
    );
    this.activeAuthModal = modal;
    modal.open();

    // 轮询：在另一个 async 上下文里跑（不阻塞 startAuth 返回）
    void (async () => {
      let pollSucceeded = false;
      try {
        const tokenResp = await flowClient.pollForToken(
          deviceCodeResp.device_code,
          deviceCodeResp.interval,
          deviceCodeResp.expires_in
        );

        // 拿到 token → 存 SecretStorage
        this.tokenStorage.setTokens(
          tokenResp.access_token,
          tokenResp.refresh_token ?? "",
          tokenResp.expires_in
        );

        // 拉取用户名
        try {
          const client = this.getClient();
          cfg.username = await client.getUser();
          await this.plugin.saveSettings();
        } catch (err) {
          syncLog.warn("getUser failed after auth", err);
        }

        pollSucceeded = true;
        modal.markSuccess();
        new Notice($t("sync.auth.success"));
        // 成功 → 等 1.5s 展示绿色成功态后自动关闭
        window.setTimeout(() => {
          modal.close();
          if (this.activeAuthModal === modal) this.activeAuthModal = null;
        }, 1500);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        syncLog.error("startAuth: device code flow failed", err);
        // 失败 → Modal 保持打开，展示错误 + 重试按钮
        modal.markFailed($t("sync.auth.pollingFailedPrefix") + msg);
      } finally {
        if (pollSucceeded) {
          this.client = null;
          this.clientFingerprint = "";
        }
        this.notifySettingsRefresh();
      }
    })();
  }

  async revokeAuth(): Promise<void> {
    // SecretStorage 清空
    this.tokenStorage.clearTokens();

    // data.json 里敏感字段也一并清空（旧逻辑保留）
    const s = this.plugin.data.settings.sync;
    s.onedriveConfig.accessToken = "";
    s.onedriveConfig.refreshToken = "";
    s.onedriveConfig.accessTokenExpiresAtTime = 0;
    s.onedriveConfig.accessTokenExpiresInSeconds = 0;
    s.onedriveConfig.username = "";
    // 同时清空 delta 续传状态与远端快照，避免换账号/重新授权后沿用旧游标
    s.onedriveConfig.deltaLink = "";
    s.onedriveConfig.remoteSnapshotMigrated = true;
    s.lastSynced = -1;
    await this.plugin.saveSettings();
    try {
      await remoteSnapshotClear();
    } catch (err) {
      // 快照清理失败不阻断 token 清理，仅记录日志
      syncLog.error("revokeAuth: failed to clear remote snapshot", err);
    }
    this.client = null;
    this.clientFingerprint = "";
    new Notice($t("sync.auth.revoked"));
    this.updateStatusBar();
    this.notifySettingsRefresh();
  }

  /** 设置页「检查可否连接」：读取 OneDrive 账户信息验证授权与网络。 */
  async checkConnection(): Promise<void> {
    new Notice($t("sync.action.checkConnChecking"));
    let errMessage = "";
    const res = await this.getClient().checkConnectivity((err) => {
      errMessage = humanizeApiError(err);
    });
    if (res) {
      new Notice($t("sync.action.checkConnSucc"));
    } else {
      new Notice($t("sync.action.checkConnFail"));
      if (errMessage !== "") {
        new Notice(errMessage);
      }
    }
  }

  /** 删除同步映射记录（prevSync 基线），用于授权账号/密码变更后强制全量比对 */
  async clearLocalSyncData(): Promise<void> {
    if (this.db !== null) {
      await clearAllPrevSyncRecordsByVault(this.db, this.vaultRandomID);
    }
    this.plugin.data.settings.sync.lastSynced = -1;
    await this.plugin.saveSettings();
    new Notice($t("sync.action.clearedLocal"));
  }

  /** 设置页整页重渲染钩子：设置页打开时由 renderSyncSettings 注册、关闭时（hide）置空。
   *  授权状态变化（OAuth 回调成功 / 撤回鉴权）后用它通知设置页即时刷新，
   *  否则「撤回鉴权」按钮要等用户切走再切回设置页才出现。 */
  private settingsRerenderCb: (() => void) | null = null;

  registerSettingsRerender(cb: (() => void) | null): void {
    this.settingsRerenderCb = cb;
  }

  private notifySettingsRefresh(): void {
    this.settingsRerenderCb?.();
  }

  // ─────────────────────────── sync run ───────────────────────────

  /** Vault Sync ribbon 元素（main.ts 创建后挂进来，同步中切换图标） */
  syncRibbon: HTMLElement | null = null;

  /** ribbon 图标随同步状态切换（移植自上游 setSyncIcon） */
  private setSyncIcon(
    running: boolean,
    triggerSource?: SyncTriggerSourceType
  ): void {
    if (!this.syncRibbon) return;
    if (running) {
      setIcon(this.syncRibbon, "refresh-ccw");
      this.syncRibbon.setAttribute(
        "aria-label",
        $t("sync.ribbon.syncing", {
          pluginName: this.plugin.manifest.name,
          triggerSource: triggerSource ?? "",
        })
      );
    } else {
      setIcon(this.syncRibbon, "rotate-ccw");
      this.syncRibbon.setAttribute("aria-label", $t("sync.ribbon.tip"));
    }
  }

  private getClient(): RemoteClient {
    const s = this.plugin.data.settings.sync;
    const fingerprint = `${s.onedriveConfig.clientID}|${s.onedriveConfig.authority}`;
    // clientID / authority 变了 → RemoteClient 里持有旧 flowClient，必须重建
    if (this.client !== null && this.clientFingerprint !== fingerprint) {
      this.client = null;
    }
    if (this.client === null) {
      const flowClient = buildDeviceCodeFlowClient(s.onedriveConfig);
      this.client = new RemoteClient(
        "onedrive",
        s.onedriveConfig,
        this.plugin.app.vault.getName(),
        this.tokenStorage,
        flowClient,
        () => this.plugin.saveSettings()
      );
      this.clientFingerprint = fingerprint;
    }
    return this.client;
  }

  /**
   * 主同步入口（移植自上游 main.ts syncRun 的 V3 流程）。
   * @param triggerSource 触发来源
   * @param silent 静默模式（自动触发时不弹 Notice，仅记录日志）
   */
  async syncRun(
    triggerSource: SyncTriggerSourceType,
    silent = false
  ): Promise<void> {
    const s = this.plugin.data.settings.sync;
    if (!s.enabled) {
      if (!silent) {
        new Notice($t("sync.status.notEnabled"));
      }
      return;
    }
    if (this.syncing) {
      if (!silent) {
        new Notice($t("sync.status.alreadySyncing"));
      }
      return;
    }
    if (!this.isReady || this.db === null) {
      if (!silent) {
        new Notice($t("sync.status.dbNotReady"));
      }
      return;
    }
    if (!this.isAuthorized) {
      if (!silent) {
        new Notice($t("sync.status.notAuthorized"));
      }
      return;
    }

    this.syncing = true;
    this.setSyncIcon(true, triggerSource);
    // 通知统一调度器：自动同步执行中（minInterval 起点在 finish 时落盘）。
    // 手动同步也标记——调度器 markRunFinished 是幂等的，不会造成问题。
    this.autoScheduler.markRunStarted();
    // 与上游语义一致：空密码 = 不加密
    const password = s.password;
    try {
      const client = this.getClient();

      this.setStatus("getting_remote_files_list");
      const listFromRemoteRes = await client.listFromRemote();

      this.setStatus("checking_password");
      const pwdCheck = await isPasswordOk(listFromRemoteRes.Contents, password);
      if (!pwdCheck.ok) {
        throw new Error(
          $t("sync.error.passwordNotMatched", {
            reason: String(pwdCheck.reason),
          })
        );
      }

      this.setStatus("getting_remote_extra_meta");
      const remoteStates = await getRemoteStates(
        listFromRemoteRes.Contents,
        this.db,
        this.vaultRandomID,
        "onedrive",
        password
      );

      this.setStatus("getting_local_meta");
      const local = this.plugin.app.vault.getAllLoadedFiles();
      const localConfigDirContents =
        s.syncConfigDir || s.syncTrash
          ? await listFilesInObsFolder(
              this.plugin.app.vault,
              this.plugin.manifest.id,
              s.syncTrash
            )
          : undefined;

      this.setStatus("generating_plan");
      const prevSyncRecords = await loadPrevSyncRecordsByVault(
        this.db,
        this.vaultRandomID
      );
      const plan = await getSyncPlanV3(
        remoteStates,
        local,
        localConfigDirContents,
        prevSyncRecords,
        "onedrive",
        triggerSource,
        this.plugin.app.vault,
        s.syncConfigDir,
        s.syncTrash,
        s.syncBookmarks,
        this.plugin.app.vault.configDir,
        s.syncUnderscoreItems,
        s.skipSizeLargerThan,
        password,
        s.syncDirection,
        s.conflictAction
      );

      const uploadCount = plan.sortedKeys.filter((key) => {
        const d = plan.plan.mixedStates[key]?.decision;
        return d === "uploadLocalToRemote" || d === "createFolder";
      }).length;
      const downloadCount = plan.sortedKeys.filter(
        (key) => plan.plan.mixedStates[key]?.decision === "downloadRemoteToLocal"
      ).length;
      const deleteCount = plan.sortedKeys.filter((key) => {
        const d = plan.plan.mixedStates[key]?.decision;
        return (
          d === "uploadLocalDelHistToRemote" ||
          d === "uploadLocalDelHistToRemoteFolder"
        );
      }).length;
      syncLog.debug(
        `sync plan: upload=${uploadCount}, download=${downloadCount}, delete=${deleteCount}`
      );

      this.setStatus("syncing", `0/${plan.sortedKeys.length}`);
      const lastSyncedTime = await doActualSyncV3(
        client,
        this.db,
        this.vaultRandomID,
        this.plugin.app.vault,
        plan.plan,
        plan.sortedKeys,
        plan.sizesGoWrong,
        async (key: string) => {
          const p = normalizePath(key);
          // 插件级「删除到哪里」设置须优先于 Obsidian 全局偏好（FileManager.trashFile
          // 跟随全局设置，无法保证送系统回收站）；移动端不支持系统回收站时
          // trashSystem 返回 false，回退 Obsidian .trash
          if (
            s.deleteToWhere === "system_trash" &&
            (await this.plugin.app.vault.adapter.trashSystem(p))
          ) {
            return;
          }
          await this.plugin.app.vault.adapter.trashLocal(p);
        },
        password,
        s.lastSynced,
        s.concurrency,
        (items) => {
          new Notice(
            $t("sync.error.sizesGoWrong", {
              count: items.length,
              first: items[0]?.key ?? "",
            })
          );
        },
        async (index, total) => {
          this.setStatus("syncing", `${index}/${total}`);
        },
        s.protectModifyPercentage >= 0
          ? s.protectModifyPercentage
          : undefined,
        (errorMsg) => {
          new Notice($t("sync.error.protectModifyPercentage", { msg: errorMsg }));
        },
        this.plugin.app.vault.configDir,
        s.syncDirection
      );

      if (lastSyncedTime !== undefined) {
        s.lastSynced = lastSyncedTime;
        await this.plugin.saveSettings();
        this.updateStatusBar();
      }

      this.setStatus("finish");
      if (!silent) {
        new Notice(
          $t("sync.status.finished", {
            upload: uploadCount,
            download: downloadCount,
            del: deleteCount,
          })
        );
      }
    } catch (err) {
      syncLog.error("sync run failed", err);
      const msg = humanizeApiError(err) || (err instanceof Error ? err.message : String(err));
      this.currentStatus = {
        ...this.currentStatus,
        status: "idle",
        lastError: msg,
      };
      for (const listener of this.statusListeners) {
        listener(this.currentStatus);
      }
      new Notice(
        $t("sync.error.syncFailed", {
          msg: msg.length > 200 ? `${msg.slice(0, 200)}…` : msg,
        })
      );
      return;
    } finally {
      this.syncing = false;
      this.setSyncIcon(false);
      this.updateStatusBar();
      // 通知统一调度器：本次结束。markRunFinished 会把 minInterval 起点推到当前时刻，
      // 且 reschedule() 可能发现还有挂起的自动请求等待执行。
      this.autoScheduler.markRunFinished();
    }

    // 成功结束后短暂停留再回到 idle
    window.setTimeout(() => {
      if (!this.syncing && this.currentStatus.status === "finish") {
        this.setStatus("idle");
      }
    }, 2000);
  }

  async changeSyncDirection(direction: SyncDirectionType): Promise<void> {
    this.plugin.data.settings.sync.syncDirection = direction;
    await this.plugin.saveSettings();
  }

  async changeConflictAction(action: ConflictActionType): Promise<void> {
    this.plugin.data.settings.sync.conflictAction = action;
    await this.plugin.saveSettings();
  }
}
