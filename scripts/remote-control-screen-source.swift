// Explicitly invoked macOS M0 screen source. No Tauri IPC or network access.
// Binary stdout records: 4-byte BE Annex-B size + 8-byte BE PTS nanoseconds + AU.
// Only stderr contains JSON diagnostics. Screen/encoded data never touches disk.
import CoreGraphics
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import ScreenCaptureKit
import VideoToolbox

private let width = 1280
private let height = 720
private let fps = 15
private let maxRecordBytes = 4 * 1024 * 1024
private let maxSafeSequence: UInt64 = 9_007_199_254_740_991
private let reportLock = NSLock()

// Shared epoch with Python/Rust: do not substitute DispatchTime uptime here.
private func monotonicNs() -> UInt64 {
    var value = timespec()
    guard clock_gettime(CLOCK_MONOTONIC, &value) == 0, value.tv_sec >= 0, value.tv_nsec >= 0 else { return 0 }
    let (seconds, overflow) = UInt64(value.tv_sec).multipliedReportingOverflow(by: 1_000_000_000)
    let (result, additionOverflow) = seconds.addingReportingOverflow(UInt64(value.tv_nsec))
    return overflow || additionOverflow ? 0 : result
}

private func report(_ message: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]) {
        let line = data + Data([10])
        // Each short pipe write is atomic; EAGAIN drops this report instead of
        // blocking capture or leaving a partial JSON line. Progress is cumulative.
        let pipeLimit = fpathconf(STDERR_FILENO, _PC_PIPE_BUF)
        guard line.count <= (pipeLimit > 0 ? Int(pipeLimit) : 512) else { return }
        guard reportLock.try() else { return }
        defer { reportLock.unlock() }
        _ = line.withUnsafeBytes { Darwin.write(STDERR_FILENO, $0.baseAddress!, $0.count) }
    }
}

private struct DisplaySnapshot: Equatable {
    let id: CGDirectDisplayID
    let bounds: CGRect
    var pixelWidth: Int
    let pixelHeight: Int
    let modeWidth: Int
    let modeHeight: Int
    let rotation: Int

    static func primary() throws -> DisplaySnapshot {
        let id = CGMainDisplayID()
        let bounds = CGDisplayBounds(id)
        let angle = CGDisplayRotation(id)
        guard id != 0, let mode = CGDisplayCopyDisplayMode(id),
              [bounds.minX, bounds.minY, bounds.width, bounds.height].allSatisfy({ $0.isFinite }),
              abs(bounds.origin.x) <= 1_000_000, abs(bounds.origin.y) <= 1_000_000,
              bounds.width >= 1, bounds.width <= 16_384, bounds.height >= 1, bounds.height <= 16_384,
              [0.0, 90.0, 180.0, 270.0].contains(angle),
              [mode.width, mode.height, mode.pixelWidth, mode.pixelHeight].allSatisfy({ $0 > 0 && $0 <= 16_384 }) else {
            throw NSError(domain: "InvalidDisplayGeometry", code: 1)
        }
        let pixels: (Int, Int)
        if CGFloat(mode.width) == bounds.width, CGFloat(mode.height) == bounds.height {
            pixels = (mode.pixelWidth, mode.pixelHeight)
        } else if CGFloat(mode.width) == bounds.height, CGFloat(mode.height) == bounds.width {
            pixels = (mode.pixelHeight, mode.pixelWidth)
        } else { throw NSError(domain: "UnknownDisplayOrientation", code: 1) }
        guard CGMainDisplayID() == id else { throw NSError(domain: "PrimaryDisplayChanged", code: 1) }
        return DisplaySnapshot(id: id, bounds: bounds, pixelWidth: pixels.0, pixelHeight: pixels.1,
                               modeWidth: mode.width, modeHeight: mode.height, rotation: Int(angle))
    }
}

private func rectFields(_ rect: CGRect) -> [String: CGFloat] {
    ["x": rect.origin.x, "y": rect.origin.y, "width": rect.width, "height": rect.height]
}

private struct CapturedLayout: Equatable {
    let display: DisplaySnapshot
    let encodedWidth: Int
    let encodedHeight: Int
    let contentRect: CGRect
    let sourceContentRect: CGRect
    let contentScale: CGFloat
    let scaleFactor: CGFloat

    static func observed(_ buffer: CVPixelBuffer, _ info: [SCStreamFrameInfo: Any], _ display: DisplaySnapshot) throws -> CapturedLayout {
        guard let rawRect = info[.contentRect] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: rawRect as CFDictionary),
              let contentScale = info[.contentScale] as? CGFloat,
              let scaleFactor = info[.scaleFactor] as? CGFloat,
              [rect.minX, rect.minY, rect.width, rect.height, contentScale, scaleFactor].allSatisfy({ $0.isFinite }),
              rect.origin.x >= 0, rect.origin.y >= 0, rect.size.width > 0, rect.size.height > 0,
              contentScale > 0, scaleFactor >= 1, scaleFactor <= 4 else {
            throw NSError(domain: "UnknownCaptureGeometry", code: 1)
        }
        let w = CVPixelBufferGetWidth(buffer), h = CVPixelBufferGetHeight(buffer)
        // contentRect is already scaled in surface points. Only scaleFactor
        // converts it to surface pixels; multiplying contentScale again is wrong.
        let pixels = CGRect(x: rect.minX * scaleFactor, y: rect.minY * scaleFactor,
                            width: rect.width * scaleFactor, height: rect.height * scaleFactor)
        let tolerance: CGFloat = 0.5
        guard w == width, h == height, pixels.maxX <= CGFloat(w), pixels.maxY <= CGFloat(h),
              abs(rect.width / contentScale - display.bounds.width) <= tolerance,
              abs(rect.height / contentScale - display.bounds.height) <= tolerance,
              abs(scaleFactor - CGFloat(display.pixelWidth) / display.bounds.width) <= 0.0001,
              abs(scaleFactor - CGFloat(display.pixelHeight) / display.bounds.height) <= 0.0001 else {
            throw NSError(domain: "PartialOrMismatchedCapture", code: 1)
        }
        return CapturedLayout(display: display, encodedWidth: w, encodedHeight: h, contentRect: pixels,
                              sourceContentRect: rect, contentScale: contentScale, scaleFactor: scaleFactor)
    }

    var message: [String: Any] {
        ["type": "screen-source-layout", "screenId": "primary", "layoutVersion": 1,
         "geometry": ["displayId": display.id, "coordinateSpace": "quartz-global-logical",
                      "displayBounds": rectFields(display.bounds),
                      "displayPixels": ["width": display.pixelWidth, "height": display.pixelHeight],
                      "rotationDegrees": display.rotation,
                      "encodedSize": ["width": encodedWidth, "height": encodedHeight],
                      "contentRect": rectFields(contentRect)]]
    }
}

private enum H264EncoderMode: String {
    case hardware
    case software
}

private func supportedH264SPS(_ bytes: UnsafePointer<UInt8>, count: Int) -> Bool {
    // RFC 6184 constrained baseline, level 3.1; constraint_set0/2 do not change
    // the negotiated profile. Never relabel unconstrained 42001f as 42e01f.
    count >= 4 && bytes[0] & 0x1f == 7 && bytes[1] == 66
        && bytes[2] & 0x4f == 0x40 && bytes[3] == 31
}

// Try each backend at most once before capture starts. Once media is active,
// encoder failures still end the session; they never reset layout or liveness.
private func selectH264Encoder<T>(_ create: (H264EncoderMode) throws -> T) throws -> (T, H264EncoderMode) {
    do { return (try create(.hardware), .hardware) }
    catch {
        let hardwareError = error
        do { return (try create(.software), .software) }
        catch {
            throw NSError(domain: "H264_ENCODER_UNAVAILABLE", code: 1,
                          userInfo: ["hardware": String(describing: hardwareError),
                                     "software": String(describing: error)])
        }
    }
}

private func createH264Encoder(_ mode: H264EncoderMode,
                               callback: VTCompressionOutputCallback?, context: UnsafeMutableRawPointer?) throws -> VTCompressionSession {
    var session: VTCompressionSession?
    let specification: [CFString: Any] = mode == .hardware
        ? [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true]
        : [kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: false]
    var ready = false
    defer { if !ready, let session { VTCompressionSessionInvalidate(session) } }
    let status = VTCompressionSessionCreate(
        allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
        encoderSpecification: specification as CFDictionary,
        imageBufferAttributes: nil, compressedDataAllocator: nil,
        outputCallback: callback, refcon: context, compressionSessionOut: &session)
    guard status == noErr, let session else { throw NSError(domain: "VTCreate", code: Int(status)) }
    let properties: [(CFString, CFTypeRef)] = [
        (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue),
        (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse),
        // Apple's software encoder rejects ConstrainedBaseline_AutoLevel but
        // its fixed Baseline 3.1 output carries the constrained-baseline bits.
        // Actual SPS is checked before any access unit leaves this process.
        (kVTCompressionPropertyKey_ProfileLevel, mode == .hardware
            ? kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel : kVTProfileLevel_H264_Baseline_3_1),
        (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: 1_000_000)),
        (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: fps)),
        (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: fps)),
    ]
    for (key, value) in properties {
        let status = VTSessionSetProperty(session, key: key, value: value)
        guard status == noErr else { throw NSError(domain: "VTConfigure", code: Int(status)) }
    }
    let prepared = VTCompressionSessionPrepareToEncodeFrames(session)
    guard prepared == noErr else { throw NSError(domain: "VTPrepare", code: Int(prepared)) }
    var rawHardware: UnsafeRawPointer?
    let inspected = VTSessionCopyProperty(session, key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
                                         allocator: nil, valueOut: &rawHardware)
    let actualHardware = rawHardware.map { Unmanaged<AnyObject>.fromOpaque($0).takeRetainedValue() as? Bool } ?? nil
    // Software encoders can omit this hardware-only inspection property. The
    // explicit EnableHardware=false specification still forbids a hardware
    // backend; if a backend does expose the property it must confirm false.
    let expectedBackend = mode == .hardware
        ? inspected == noErr && actualHardware == true
        : (inspected == kVTPropertyNotSupportedErr && actualHardware == nil)
            || (inspected == noErr && actualHardware == false)
    guard expectedBackend else {
        throw NSError(domain: "VTEncoderSelection", code: Int(inspected))
    }
    ready = true
    return session
}

#if REMOTE_CONTROL_TEST_FAULTS
private struct SourceTestOptions {
    let fault: SourceTestFault?
    let letterbox: Bool
    static func parse(_ args: [String]) throws -> SourceTestOptions {
        guard args.filter({ $0 == "--test-letterbox" }).count <= 1 else { throw NSError(domain: "InvalidTestFault", code: 1) }
        return SourceTestOptions(fault: try SourceTestFault.parse(args.filter { $0 != "--test-letterbox" }),
                                 letterbox: args.contains("--test-letterbox"))
    }
}
// Exists only in an explicitly compiled test executable, never in a normal source binary.
private final class SourceTestFault: @unchecked Sendable {
    private let lock = NSLock()
    private let stage: String
    private let after: UInt64
    private let duration: UInt64?
    private var started: UInt64?
    private var began = false
    private var ended = false

    private init(stage: String, afterMs: UInt64, durationMs: UInt64?) {
        self.stage = stage
        after = afterMs * 1_000_000
        duration = durationMs.map { $0 * 1_000_000 }
    }
    static func parse(_ args: [String]) throws -> SourceTestFault? {
        if args.isEmpty { return nil }
        guard args.count == 4 || args.count == 6 else { throw NSError(domain: "InvalidTestFault", code: 1) }
        var fields: [String: String] = [:]
        for index in stride(from: 0, to: args.count, by: 2) {
            let name = args[index]
            guard ["--test-freeze-stage", "--test-freeze-after-ms", "--test-freeze-duration-ms"].contains(name), fields[name] == nil else {
                throw NSError(domain: "InvalidTestFault", code: 1)
            }
            fields[name] = args[index + 1]
        }
        func number(_ name: String) throws -> UInt64 {
            guard let raw = fields[name], !raw.isEmpty, raw.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
                  let value = UInt64(raw), value <= 40_000 else { throw NSError(domain: "InvalidTestFault", code: 1) }
            return value
        }
        guard let stage = fields["--test-freeze-stage"], ["capture", "encode", "layout"].contains(stage) else {
            throw NSError(domain: "InvalidTestFault", code: 1)
        }
        let after = try number("--test-freeze-after-ms")
        let duration = fields["--test-freeze-duration-ms"] == nil ? nil : try number("--test-freeze-duration-ms")
        guard duration != 0 else { throw NSError(domain: "InvalidTestFault", code: 1) }
        return SourceTestFault(stage: stage, afterMs: after, durationMs: duration)
    }
    func start() {
        lock.lock()
        started = DispatchTime.now().uptimeNanoseconds
        lock.unlock()
    }
    func suppresses(_ event: String) -> Bool {
        guard event == stage else { return false }
        lock.lock()
        guard let started else { lock.unlock(); return false }
        let elapsed = DispatchTime.now().uptimeNanoseconds - started
        let active = elapsed >= after && (duration == nil || elapsed < after + duration!)
        let reportBegin = elapsed >= after && !began
        let reportEnd = duration != nil && elapsed >= after + duration! && !ended
        began = began || reportBegin
        ended = ended || reportEnd
        lock.unlock()
        if reportBegin { report(["type": "screen-source-test-fault", "phase": "begin", "stage": stage]) }
        if reportEnd { report(["type": "screen-source-test-fault", "phase": "end", "stage": stage]) }
        return active
    }
}
#endif

@available(macOS 13.0, *)
// Shared supervisor/capture fields use `lock`, output is serialized separately,
// and encoder teardown drains the encode queue and VideoToolbox callbacks.
final class ScreenEncoder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let outputLock = NSLock()
    private let encodeQueue = DispatchQueue(label: "todesk.screen-probe.encode")
    private let progressQueue = DispatchQueue(label: "todesk.screen-probe.progress")
    private var latest: CVPixelBuffer?
    private var stopReason: String?
    private var heartbeat = DispatchTime.now().uptimeNanoseconds
    private var captureActivity = DispatchTime.now().uptimeNanoseconds
    private var session: VTCompressionSession?
    private var timer: DispatchSourceTimer?
    private var progressTimer: DispatchSourceTimer?
    private var captureSeq: UInt64 = 0
    private var captureMonotonicNs: UInt64 = 0
    private var encodedSeq: UInt64 = 0
    private var encodedMonotonicNs: UInt64 = 0
    private var displaySnapshot: DisplaySnapshot?
    private var capturedLayout: CapturedLayout?
    private var capturedFrames = 0
    private var encodedFrames = 0
    private var encodedBytes = 0
    private var submittedFrames = 0
    private var idleCallbacks = 0
    private var profileLevelId = "unknown"
    private var hardware = false
    private let started = DispatchTime.now().uptimeNanoseconds
#if REMOTE_CONTROL_TEST_FAULTS
    private let testFault: SourceTestFault?
    fileprivate init(testFault: SourceTestFault?) {
        self.testFault = testFault
        super.init()
    }
#endif

    func requestStop(_ reason: String) {
        lock.lock()
        if stopReason == nil { stopReason = reason }
        lock.unlock()
    }

    func receiveHeartbeat() {
        lock.lock()
        heartbeat = DispatchTime.now().uptimeNanoseconds
        lock.unlock()
    }

    func bindPrimaryDisplay(_ id: CGDirectDisplayID) throws {
        let snapshot = try DisplaySnapshot.primary()
        guard snapshot.id == id else { throw NSError(domain: "DisplayChangedBeforeCapture", code: 1) }
        lock.lock()
        displaySnapshot = snapshot
        lock.unlock()
    }

    private func currentDisplayIsBound() -> Bool {
        do {
            var actual = try DisplaySnapshot.primary()
#if REMOTE_CONTROL_TEST_FAULTS
            // Exercise the same comparison without publishing forged geometry.
            if testFault?.suppresses("layout") == true { actual.pixelWidth += 2 }
#endif
            lock.lock()
            let unchanged = displaySnapshot == actual
            lock.unlock()
            if !unchanged { requestStop("MEDIA_LAYOUT_CHANGED") }
            return unchanged
        } catch {
            requestStop("MEDIA_LAYOUT_CHANGED")
            return false
        }
    }

    func reason() -> String? {
        lock.lock()
        defer { lock.unlock() }
        let now = DispatchTime.now().uptimeNanoseconds
        if stopReason == nil && now - heartbeat >= 3_000_000_000 { stopReason = "SUPERVISOR_TIMEOUT" }
        // Rust pauses input after 3s and ends at 10s. Leave a small margin for
        // its watchdog, with an independent 12s source stop fallback.
        if stopReason == nil && now - captureActivity >= 12_000_000_000 { stopReason = "CAPTURE_TIMEOUT" }
        return stopReason
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        requestStop("CAPTURE_ERROR")
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int else { return }
        // Check even idle callbacks, before test freezes or any cached encoding.
        guard currentDisplayIsBound() else { return }
#if REMOTE_CONTROL_TEST_FAULTS
        if testFault?.suppresses("capture") == true { return }
#endif
        lock.lock()
        var healthy = false
        if SCFrameStatus(rawValue: status) == .complete, let buffer = sample.imageBuffer {
            do {
                guard let displaySnapshot else { throw NSError(domain: "UnboundDisplay", code: 1) }
                let observed = try CapturedLayout.observed(buffer, attachments[0], displaySnapshot)
                if let capturedLayout, capturedLayout != observed {
                    stopReason = stopReason ?? "MEDIA_LAYOUT_CHANGED"
                    lock.unlock()
                    return
                }
                capturedLayout = observed
            } catch {
                stopReason = stopReason ?? (capturedLayout == nil ? "MEDIA_LAYOUT_INVALID" : "MEDIA_LAYOUT_CHANGED")
                lock.unlock()
                return
            }
            latest = buffer
            capturedFrames += 1
            healthy = true
        } else if SCFrameStatus(rawValue: status) == .idle, latest != nil {
            idleCallbacks += 1
            healthy = true
        }
        // Blank/suspended/stopped, missing buffers and idle-before-first-frame
        // are not evidence of a healthy capture source.
        if healthy {
            let observed = monotonicNs()
            if observed <= captureMonotonicNs || captureSeq >= maxSafeSequence {
                stopReason = stopReason ?? "CAPTURE_PROGRESS_INVALID"
            } else {
                captureSeq += 1
                captureMonotonicNs = observed
                captureActivity = DispatchTime.now().uptimeNanoseconds
            }
        }
        lock.unlock()
    }

    func configure() throws {
        let (configured, mode) = try selectH264Encoder { mode in
            try createH264Encoder(mode, callback: { context, _, status, _, sample in
                guard let context else { return }
                let encoder = Unmanaged<ScreenEncoder>.fromOpaque(context).takeUnretainedValue()
                guard status == noErr, let sample else { encoder.requestStop("ENCODE_ERROR"); return }
                encoder.output(sample)
            }, context: Unmanaged.passUnretained(self).toOpaque())
        }
        session = configured
        hardware = mode == .hardware
        // Nonblocking output prevents a stalled parent from stopping the native
        // supervisor. Any incomplete/slow record ends the stream; never replay.
        let flags = fcntl(STDOUT_FILENO, F_GETFL)
        guard flags >= 0, fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK) == 0 else {
            throw NSError(domain: "OutputPipe", code: Int(errno))
        }
    }

    func startEncoding() {
#if REMOTE_CONTROL_TEST_FAULTS
        testFault?.start()
#endif
        let timer = DispatchSource.makeTimerSource(queue: encodeQueue)
        timer.schedule(deadline: .now(), repeating: .nanoseconds(1_000_000_000 / fps))
        timer.setEventHandler { [weak self] in self?.encodeLatest() }
        self.timer = timer
        timer.resume()
        let progress = DispatchSource.makeTimerSource(queue: progressQueue)
        progress.schedule(deadline: .now(), repeating: .milliseconds(250))
        progress.setEventHandler { [weak self] in self?.reportProgress() }
        progressTimer = progress
        progress.resume()
    }

    private func reportProgress() {
        lock.lock()
        let layout = capturedLayout?.message
        let message: [String: Any] = ["type": "screen-source-progress", "captureSeq": captureSeq,
            "captureMonotonicNs": String(captureMonotonicNs), "encodedSeq": encodedSeq,
            "encodedMonotonicNs": String(encodedMonotonicNs)]
        lock.unlock()
        if let layout { report(layout) }
        report(message)
    }

    private func encodeLatest() {
        guard reason() == nil, let session else { return }
#if REMOTE_CONTROL_TEST_FAULTS
        if testFault?.suppresses("encode") == true { return }
#endif
        lock.lock()
        let frame = latest
        let index = submittedFrames
        if frame != nil { submittedFrames += 1 }
        lock.unlock()
        guard let frame else { return }
        var flags: VTEncodeInfoFlags = []
        let status = VTCompressionSessionEncodeFrame(
            session, imageBuffer: frame,
            presentationTimeStamp: CMTime(value: Int64(index), timescale: Int32(fps)),
            duration: CMTime(value: 1, timescale: Int32(fps)),
            frameProperties: index % fps == 0 ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil,
            sourceFrameRefcon: nil, infoFlagsOut: &flags)
        if status != noErr { requestStop("ENCODE_SUBMIT_ERROR") }
    }

    private func output(_ sample: CMSampleBuffer) {
        outputLock.lock()
        defer { outputLock.unlock() }
        guard reason() == nil, let format = sample.formatDescription, let block = sample.dataBuffer else { return }
        var headerSize: Int32 = 0
        var count = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0,
            parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count,
            nalUnitHeaderLengthOut: &headerSize) == noErr, headerSize == 4, count >= 2, count <= 8 else {
            requestStop("INVALID_H264_FORMAT"); return
        }
        var accessUnit = Data()
        // Repeat parameter sets to make each periodic IDR independently usable.
        for index in 0..<count {
            var pointer: UnsafePointer<UInt8>?
            var size = 0
            guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index,
                parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: nil,
                nalUnitHeaderLengthOut: nil) == noErr, let pointer else { requestStop("MISSING_PARAMETER_SET"); return }
            if index == 0 && !supportedH264SPS(pointer, count: size) { requestStop("UNSUPPORTED_H264_PROFILE"); return }
            accessUnit.append(contentsOf: [0, 0, 0, 1])
            accessUnit.append(pointer, count: size)
            if index == 0 && size >= 4 {
                lock.lock()
                profileLevelId = [pointer[1], pointer[2], pointer[3]].map { String(format: "%02x", $0) }.joined()
                lock.unlock()
            }
        }
        let size = CMBlockBufferGetDataLength(block)
        guard size > 4 && size <= maxRecordBytes else { requestStop("ENCODED_FRAME_TOO_LARGE"); return }
        var bytes = Data(count: size)
        let status = bytes.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: size, destination: $0.baseAddress!) }
        guard status == noErr else { requestStop("ENCODED_FRAME_COPY_ERROR"); return }
        var offset = 0
        while offset + 4 <= size {
            let length = bytes[offset..<(offset + 4)].reduce(0) { ($0 << 8) | Int($1) }
            offset += 4
            guard length > 0 && length <= size - offset else { requestStop("INVALID_NAL_LENGTH"); return }
            accessUnit.append(contentsOf: [0, 0, 0, 1])
            accessUnit.append(bytes[offset..<(offset + length)])
            offset += length
        }
        guard offset == size && accessUnit.count <= maxRecordBytes else { requestStop("INVALID_ACCESS_UNIT"); return }
        // This observes real successful VT output, independently from source
        // callbacks and independently from the subsequent pipe/GStreamer push.
        lock.lock()
        let observed = monotonicNs()
        let validProgress = observed > encodedMonotonicNs && encodedSeq < maxSafeSequence
        if validProgress {
            encodedSeq += 1
            encodedMonotonicNs = observed
        } else {
            stopReason = stopReason ?? "ENCODE_PROGRESS_INVALID"
        }
        lock.unlock()
        guard validProgress else { return }
        let pts = UInt64(CMTimeGetSeconds(sample.presentationTimeStamp) * 1_000_000_000)
        var length = UInt32(accessUnit.count).bigEndian
        var timestamp = pts.bigEndian
        var record = Data(bytes: &length, count: 4)
        record.append(Data(bytes: &timestamp, count: 8))
        record.append(accessUnit)
        if writeRecord(record) {
            lock.lock()
            encodedFrames += 1
            encodedBytes += accessUnit.count
            lock.unlock()
        }
    }

    private func writeRecord(_ record: Data) -> Bool {
        let deadline = DispatchTime.now().uptimeNanoseconds + 500_000_000
        return record.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                if reason() != nil { return false }
                let count = Darwin.write(STDOUT_FILENO, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if count > 0 { offset += count; continue }
                if errno == EINTR { continue }
                if errno == EAGAIN && DispatchTime.now().uptimeNanoseconds < deadline { usleep(1000); continue }
                requestStop(errno == EPIPE ? "OUTPUT_PIPE_CLOSED" : "OUTPUT_BACKPRESSURE")
                return false
            }
            return true
        }
    }

    func finish() -> [String: Any] {
        progressTimer?.cancel()
        progressQueue.sync {}
        timer?.cancel()
        encodeQueue.sync {}
        if let session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
        }
        lock.lock()
        defer { lock.unlock() }
        latest = nil
        return ["type": "screen-source-stopped", "source": "screen", "codec": "H264",
                "capturedFrames": capturedFrames, "idleCallbacks": idleCallbacks,
                "submittedFrames": submittedFrames, "encodedFrames": encodedFrames, "encodedBytes": encodedBytes,
                "profileLevelId": profileLevelId, "hardware": hardware, "width": width, "height": height,
                "fpsLimit": fps, "elapsedMs": (DispatchTime.now().uptimeNanoseconds - started) / 1_000_000,
                "reason": stopReason ?? "UNKNOWN", "framesStored": 0]
    }
}

@main
struct ScreenSource {
    static func main() async {
        signal(SIGPIPE, SIG_IGN)
        let diagnosticsFlags = fcntl(STDERR_FILENO, F_GETFL)
        guard diagnosticsFlags >= 0, fcntl(STDERR_FILENO, F_SETFL, diagnosticsFlags | O_NONBLOCK) == 0 else { exit(2) }
#if REMOTE_CONTROL_TEST_FAULTS
        let testOptions: SourceTestOptions
        do { testOptions = try SourceTestOptions.parse(Array(CommandLine.arguments.dropFirst())) }
        catch { report(["type": "error", "reason": "INVALID_TEST_SOURCE_ARGUMENTS"]); exit(2) }
#else
        guard CommandLine.arguments.count == 1 else { report(["type": "error", "reason": "SOURCE_ARGUMENTS_FORBIDDEN"]); exit(2) }
#endif
        guard #available(macOS 13.0, *), CGPreflightScreenCaptureAccess() else {
            report(["type": "error", "reason": "SCREEN_PERMISSION_OR_PLATFORM_UNAVAILABLE"])
            exit(2)
        }
#if REMOTE_CONTROL_TEST_FAULTS
        let encoder = ScreenEncoder(testFault: testOptions.fault)
#else
        let encoder = ScreenEncoder()
#endif
        signal(SIGTERM, SIG_IGN)
        let signalSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
        signalSource.setEventHandler { encoder.requestStop("TERMINATED") }
        signalSource.resume()
        DispatchQueue.global().async {
            while let line = readLine() {
                if line == "heartbeat" { encoder.receiveHeartbeat() }
                else if line == "stop" { encoder.requestStop("LOCAL_STOP"); return }
                else { encoder.requestStop("INVALID_SUPERVISOR_MESSAGE"); return }
            }
            encoder.requestStop("SUPERVISOR_PIPE_CLOSED")
        }
        do {
            try encoder.configure()
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            // "primary" must match the native input executor's CGMainDisplayID;
            // ScreenCaptureKit does not promise that displays.first is primary.
            guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
                throw NSError(domain: "NoPrimaryDisplay", code: 1)
            }
            try encoder.bindPrimaryDisplay(display.displayID)
            let config = SCStreamConfiguration()
            config.width = width
            config.height = height
            config.queueDepth = 3
            config.capturesAudio = false
            config.showsCursor = true
            config.minimumFrameInterval = CMTime(value: 1, timescale: Int32(fps))
#if REMOTE_CONTROL_TEST_FAULTS
            if testOptions.letterbox { config.destinationRect = CGRect(x: 160, y: 90, width: 960, height: 540) }
#endif
            let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: encoder)
            try stream.addStreamOutput(encoder, type: .screen, sampleHandlerQueue: DispatchQueue(label: "todesk.screen-probe.capture"))
            try await stream.startCapture()
            report(["type": "screen-source-started", "pid": ProcessInfo.processInfo.processIdentifier, "source": "screen"])
            encoder.startEncoding()
            while encoder.reason() == nil { try await Task.sleep(nanoseconds: 20_000_000) }
            try await stream.stopCapture()
            var result = encoder.finish()
            result["captureStopped"] = true
            report(result)
        } catch {
            encoder.requestStop("SOURCE_ERROR")
            report(encoder.finish())
            report(["type": "error", "reason": "SCREEN_SOURCE_FAILED", "error": String(describing: error)])
            exit(2)
        }
        signalSource.cancel()
    }
}
