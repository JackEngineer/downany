import Foundation

public actor DownloadCoordinator {
    private let service: YtDlpService
    private let historyStore: HistoryStore
    private var tasks: [UUID: DownloadTask] = [:]
    private var queue: [UUID] = []
    private var runningExecutions: [UUID: ProcessExecution] = [:]
    private var maxConcurrentDownloads: Int
    private var stateDidChange: (@Sendable () -> Void)?

    public init(
        service: YtDlpService,
        historyStore: HistoryStore,
        maxConcurrentDownloads: Int = 3
    ) {
        self.service = service
        self.historyStore = historyStore
        self.maxConcurrentDownloads = max(1, min(maxConcurrentDownloads, 10))
    }

    public func setStateDidChangeHandler(_ handler: @escaping @Sendable () -> Void) {
        stateDidChange = handler
    }

    public func updateMaxConcurrentDownloads(_ value: Int) async {
        maxConcurrentDownloads = max(1, min(value, 10))
        notifyStateDidChange()
        await drainQueue()
    }

    public func enqueue(_ task: DownloadTask) async {
        tasks[task.id] = task
        queue.append(task.id)
        notifyStateDidChange()
        await drainQueue()
    }

    public func pause(_ taskID: UUID) async {
        guard var task = tasks[taskID], task.status == .downloading else {
            return
        }

        runningExecutions[taskID]?.cancel()
        runningExecutions.removeValue(forKey: taskID)
        task.status = .paused
        tasks[taskID] = task
        notifyStateDidChange()
    }

    public func resume(_ taskID: UUID) async {
        guard var task = tasks[taskID], task.status == .paused else {
            return
        }

        task.status = .pending
        tasks[taskID] = task
        queue.append(taskID)
        notifyStateDidChange()
        await drainQueue()
    }

    public func cancel(_ taskID: UUID) async {
        guard var task = tasks[taskID] else {
            return
        }

        runningExecutions[taskID]?.cancel()
        runningExecutions.removeValue(forKey: taskID)
        queue.removeAll { $0 == taskID }
        task.status = .cancelled
        task.completedAt = Date()
        tasks[taskID] = task
        try? await historyStore.upsertDownloadTask(task)
        notifyStateDidChange()
    }

    public func retry(_ taskID: UUID) async -> Bool {
        guard var task = tasks[taskID], task.status == .failed || task.status == .cancelled else {
            return false
        }

        task.status = .pending
        task.progress = 0
        task.speed = "0 B/s"
        task.eta = "N/A"
        task.errorMessage = ""
        task.startedAt = nil
        task.completedAt = nil
        tasks[taskID] = task
        queue.append(taskID)
        notifyStateDidChange()
        await drainQueue()
        return true
    }

    /// 从历史记录恢复任务并重新入队（应用重启后内存无该任务时使用）。
    public func enqueueRestored(_ task: DownloadTask) async {
        var restored = task
        restored.status = .pending
        restored.progress = 0
        restored.speed = "0 B/s"
        restored.eta = "N/A"
        restored.errorMessage = ""
        restored.startedAt = nil
        restored.completedAt = nil
        tasks[restored.id] = restored
        queue.append(restored.id)
        notifyStateDidChange()
        await drainQueue()
    }

    public func removeTask(id: UUID) {
        tasks.removeValue(forKey: id)
        queue.removeAll { $0 == id }
        runningExecutions[id]?.cancel()
        runningExecutions.removeValue(forKey: id)
        notifyStateDidChange()
    }

    public func restorePersistedQueue() async -> Int {
        let saved = await historyStore.loadActiveQueue()
        var restored = 0
        for task in saved {
            if tasks[task.id] != nil {
                continue
            }
            var pending = task
            if pending.status == .downloading || pending.status == .paused {
                pending.status = .pending
            }
            guard pending.status == .pending || pending.status == .failed else {
                continue
            }
            pending.progress = pending.status == .failed ? pending.progress : 0
            pending.speed = "0 B/s"
            pending.eta = "N/A"
            pending.errorMessage = pending.status == .failed ? pending.errorMessage : ""
            pending.startedAt = nil
            pending.completedAt = nil
            if pending.status == .failed {
                pending.status = .pending
                pending.progress = 0
                pending.errorMessage = ""
            }
            tasks[pending.id] = pending
            queue.append(pending.id)
            restored += 1
        }
        if restored > 0 {
            notifyStateDidChange()
            await drainQueue()
        }
        return restored
    }

    public func activeQueueSnapshot() -> [DownloadTask] {
        tasks.values
            .filter { [.pending, .downloading, .paused, .failed].contains($0.status) }
            .sorted { $0.createdAt > $1.createdAt }
    }

    public func snapshot() -> [DownloadTask] {
        tasks.values.sorted { $0.createdAt > $1.createdAt }
    }

    public func task(id: UUID) -> DownloadTask? {
        tasks[id]
    }

    private func persistActiveQueue() async {
        let toSave: [DownloadTask] = tasks.values.compactMap { task in
            switch task.status {
            case .pending, .paused, .failed:
                return task
            case .downloading:
                var copy = task
                copy.status = .pending
                copy.speed = "0 B/s"
                copy.eta = "N/A"
                return copy
            case .completed, .cancelled:
                return nil
            }
        }
        try? await historyStore.saveActiveQueue(toSave)
    }

    private func drainQueue() async {
        while runningExecutions.count < maxConcurrentDownloads, let nextTaskID = nextPendingTaskID() {
            await startTask(taskID: nextTaskID)
        }
    }

    private func nextPendingTaskID() -> UUID? {
        queue.first { taskID in
            guard let task = tasks[taskID] else {
                return false
            }
            return task.status == .pending && runningExecutions[taskID] == nil
        }
    }

    private func startTask(taskID: UUID) async {
        guard var task = tasks[taskID] else {
            return
        }

        queue.removeAll { $0 == taskID }
        task.status = .downloading
        task.startedAt = task.startedAt ?? Date()
        tasks[taskID] = task
        notifyStateDidChange()

        do {
            let execution = try service.makeDownloadExecution(for: task) { [weak self] progress in
                Task { await self?.updateProgress(taskID: taskID, progress: progress) }
            }
            try execution.start()
            runningExecutions[taskID] = execution

            Task.detached { [execution] in
                let result = execution.waitUntilExit()
                await self.finishTask(taskID: taskID, result: result)
            }
        } catch {
            task.status = .failed
            task.errorMessage = error.localizedDescription
            task.completedAt = Date()
            tasks[taskID] = task
            try? await historyStore.upsertDownloadTask(task)
            notifyStateDidChange()
            await drainQueue()
        }
    }

    private func updateProgress(taskID: UUID, progress: DownloadProgress) async {
        guard var task = tasks[taskID], task.status == .downloading else {
            return
        }

        task.progress = progress.percent
        task.speed = progress.speed
        task.eta = progress.eta
        tasks[taskID] = task
        notifyStateDidChange()
    }

    private func finishTask(taskID: UUID, result: ProcessResult) async {
        runningExecutions.removeValue(forKey: taskID)
        guard var task = tasks[taskID] else {
            await drainQueue()
            return
        }

        if task.status == .paused || task.status == .cancelled {
            try? await historyStore.upsertDownloadTask(task)
            notifyStateDidChange()
            await drainQueue()
            return
        }

        if result.exitCode == 0 {
            task.status = .completed
            task.progress = 100
            task.completedAt = Date()
            task.filePath = service.parseDownloadOutputPath(from: result.stdout) ?? task.filePath
            task.errorMessage = ""
        } else {
            task.status = .failed
            task.completedAt = Date()
            task.errorMessage = result.stderr.isEmpty ? result.stdout : result.stderr
        }

        tasks[taskID] = task
        try? await historyStore.upsertDownloadTask(task)
        notifyStateDidChange()
        await drainQueue()
    }

    private func notifyStateDidChange() {
        stateDidChange?()
        Task { await self.persistActiveQueue() }
    }
}
