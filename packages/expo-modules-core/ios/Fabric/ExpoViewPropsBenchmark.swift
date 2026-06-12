// Copyright 2025-present 650 Industries. All rights reserved.

import Foundation

/**
 Lightweight, process-wide counters used to benchmark the JSI view-props decoding path
 against the legacy `folly::dynamic` / `NSDictionary` path. Always present (so the benchmark
 harness links regardless of the `EXPO_JSI_VIEW_PROPS` flag), but only fed by the decode/apply
 code paths — so with the flag off, `decodeNanos`/`decodedPropCount` stay zero and the legacy
 apply time shows up under `applyNanos`.

 All times are in mach absolute-time ticks accumulated raw; convert to nanoseconds with the
 timebase when reading. Reads/writes aren't synchronized: the harness must drive updates
 serially (which it does — Fabric props parse on the JS thread, apply on the main thread, and
 the harness waits between batches), and the small races that remain don't matter for a
 benchmark counter.
 */
@objc(EXViewPropsBenchmark)
public final class ViewPropsBenchmark: NSObject {
  /// Accumulated mach ticks spent decoding props from JS values on the JavaScript thread.
  nonisolated(unsafe) public static var decodeTicks: UInt64 = 0

  /// Accumulated mach ticks spent applying props to views on the main thread (both the
  /// JSI `applyDecoded` path and the legacy `set` path).
  nonisolated(unsafe) public static var applyTicks: UInt64 = 0

  /// Number of individual props decoded straight from their JS value.
  nonisolated(unsafe) public static var decodedPropCount: UInt64 = 0

  /// Number of individual props applied via the legacy (dictionary) path.
  nonisolated(unsafe) public static var legacyPropCount: UInt64 = 0

  /// Number of `cloneProps`/decode invocations that ran (i.e. props-parse passes). Note that
  /// Fabric may call `cloneProps` more than once per visual update, so this can exceed the
  /// number of apply passes.
  nonisolated(unsafe) public static var decodePassCount: UInt64 = 0

  /// Number of apply invocations that ran (`finalizeUpdates` → `applyDecodedProps`/`updateProps`
  /// on the main thread). Use this to normalize `applyMs`, since it differs from
  /// `decodePassCount`.
  nonisolated(unsafe) public static var applyPassCount: UInt64 = 0

  private static let timebase: mach_timebase_info_data_t = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return info
  }()

  private static func nanos(from ticks: UInt64) -> Double {
    return Double(ticks) * Double(timebase.numer) / Double(timebase.denom)
  }

  /// Returns the accumulated counters as a dictionary, with times converted to milliseconds.
  @objc
  public static func snapshot() -> [String: Any] {
    return [
      "decodeMs": nanos(from: decodeTicks) / 1_000_000,
      "applyMs": nanos(from: applyTicks) / 1_000_000,
      "decodedPropCount": decodedPropCount,
      "legacyPropCount": legacyPropCount,
      "decodePassCount": decodePassCount,
      "applyPassCount": applyPassCount
    ]
  }

  /// Resets all counters to zero. Call before a measured run.
  @objc
  public static func reset() {
    decodeTicks = 0
    applyTicks = 0
    decodedPropCount = 0
    legacyPropCount = 0
    decodePassCount = 0
    applyPassCount = 0
  }
}
