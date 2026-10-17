import Foundation

/// A session delegate is required: async URLSession download convenience calls
/// do not reliably forward byte callbacks to a per-task delegate on macOS.
public final class ArchiveDownload: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let expectedSize: Int64
    private let destination: URL
    private let changed: @Sendable (Int) -> Void
    // Delegate callbacks are serial. Cancellation and continuation setup can
    // happen on other executors, so their shared lifecycle uses this lock.
    private let lock = NSLock()
    private var continuation: CheckedContinuation<URLResponse, Error>?
    private var task: URLSessionDownloadTask?
    private var cancelled = false
    private var lastProgress = -1
    private var fileError: Error?

    private init(expectedSize: Int64, destination: URL, changed: @escaping @Sendable (Int) -> Void) {
        self.expectedSize = expectedSize
        self.destination = destination
        self.changed = changed
    }

    public static func download(from url: URL, to destination: URL, expectedSize: Int64,
                                configuration: URLSessionConfiguration = .ephemeral,
                                changed: @escaping @Sendable (Int) -> Void) async throws -> URLResponse {
        let transfer = ArchiveDownload(expectedSize: expectedSize, destination: destination, changed: changed)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                transfer.lock.lock()
                if transfer.cancelled {
                    transfer.lock.unlock()
                    continuation.resume(throwing: CancellationError())
                    return
                }
                let session = URLSession(configuration: configuration, delegate: transfer, delegateQueue: nil)
                let task = session.downloadTask(with: url)
                transfer.continuation = continuation
                transfer.task = task
                transfer.lock.unlock()
                task.resume()
            }
        } onCancel: { transfer.cancel() }
    }

    private func cancel() {
        lock.lock()
        cancelled = true
        let current = task
        lock.unlock()
        current?.cancel()
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                           didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                           totalBytesExpectedToWrite: Int64) {
        guard expectedSize > 0 else { return }
        // Use the published asset size when the CDN omits Content-Length.
        // Only archive validation may declare completion; callbacks stop at 99%.
        let progress = Int(min(99, max(0, Double(totalBytesWritten) / Double(expectedSize) * 100)))
        guard progress > lastProgress else { return }
        lastProgress = progress
        changed(progress)
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                           didFinishDownloadingTo location: URL) {
        // URLSession deletes its temporary file as soon as this callback returns.
        do { try FileManager.default.moveItem(at: location, to: destination) }
        catch { fileError = error }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let pending = continuation
        continuation = nil
        self.task = nil
        let wasCancelled = cancelled
        lock.unlock()
        defer { session.finishTasksAndInvalidate() }
        if let failure = error ?? fileError ?? (wasCancelled ? CancellationError() : nil) {
            try? FileManager.default.removeItem(at: destination)
            pending?.resume(throwing: failure)
        } else if let response = task.response {
            pending?.resume(returning: response)
        } else {
            try? FileManager.default.removeItem(at: destination)
            pending?.resume(throwing: URLError(.badServerResponse))
        }
    }
}
