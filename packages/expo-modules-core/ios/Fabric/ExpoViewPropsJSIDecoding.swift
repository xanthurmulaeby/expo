// Copyright 2025-present 650 Industries. All rights reserved.

import ExpoModulesJSI

/**
 An opaque container of view-prop values that were decoded straight from their JavaScript
 values on the JavaScript thread (see the JSI view-props decoding design).

 The decoded values are arbitrary Swift values (primitives, records, shared object
 references, …), so they cannot be bridged through an `NSDictionary`. Instead this class is
 passed back to native as an opaque `NSObject` and unboxed again in Swift when applying the
 props to the view on the main thread.
 */
@objc(EXDecodedViewProps)
public final class DecodedViewProps: NSObject {
  // `nonisolated(unsafe)` because the values are produced on the JS thread and read on the
  // main thread; the design guarantees only thread-safe (detached) values land here, and the
  // two accesses never overlap (decode fully completes before apply begins).
  nonisolated(unsafe) internal let values: [String: Any]

  internal init(values: [String: Any]) {
    self.values = values
  }

  /**
   Whether the given prop was decoded on the JavaScript thread (and so will be applied via
   `applyDecodedProps(_:)`). Used by `finalizeUpdates:` to skip re-materializing the same prop
   through the legacy `folly::dynamic` -> `NSDictionary` path on the main thread.
   */
  @objc
  public func contains(_ key: String) -> Bool {
    return values.keys.contains(key)
  }
}

/**
 Decodes Fabric view props straight from their JavaScript values on the JavaScript thread.

 This is a standalone, **non-`@MainActor`** type on purpose: `ExpoFabricView` is a `UIView`
 subclass and therefore main-actor-isolated, so a method on it could not be called from the
 JS (props-parse) thread without tripping the main-actor isolation check. The registry of
 prop definitions is keyed by the dynamic view class name and guarded by a mutex because it's
 written on the main thread (during component registration) and read on the JS thread (during
 props parsing).
 */
@objc(EXViewPropsJSIDecoder)
public final class ViewPropsJSIDecoder: NSObject {
  private static let lock = Mutex<[String: [String: AnyViewProp]]>([:])

  /**
   Registers the prop definitions for the given dynamic view class name, so props can be
   resolved at Fabric props-parse time (before any view instance exists).
   */
  public static func register(propsDict: [String: AnyViewProp], forClassName className: String) {
    lock.withLock { registry in
      registry[className] = propsDict
    }
  }

  /**
   Decodes JSI-backed view props on the JavaScript thread.

   Called from the Objective-C++ decode shim during Fabric props parsing. Resolves the prop
   definitions for `className`, reads each declared prop's value off the props object, decodes
   it through the regular dynamic-type machinery, and returns the decoded values boxed in a
   `DecodedViewProps`. Props not declared by the view (inherited base-view / Yoga props), or
   that fail to decode, are skipped here and left for the legacy main-thread dictionary path.

   - Parameters:
     - className: the dynamic view class name used to resolve the prop definitions.
     - appContext: the app context whose runtime owns `propsObjectPointer`.
     - propsObjectPointer: a raw pointer to the props object as a `facebook::jsi::Value`.
   - Returns: a `DecodedViewProps`, or `nil` if there's nothing to decode.

   Must be called on the JavaScript thread.
   */
  @objc
  public static func decodeProps(
    forClassName className: String,
    appContext: AppContext,
    propsObjectPointer: UnsafeRawPointer
  ) -> DecodedViewProps? {
    guard let propsDict = lock.withLock({ $0[className] }) else {
      return nil
    }
    guard let runtime = try? appContext.runtime else {
      return nil
    }

    // Gate on the reliable pthread-id check rather than `JavaScriptActor`'s thread-*name*
    // heuristic: Fabric's props-parse thread is the JS pthread, but `NSThread.current.name`
    // isn't set there. If for any reason we're not on the JS thread, bail to the legacy path.
    guard runtime.isOnJavaScriptThread() else {
      return nil
    }

    // `assumeIsolatedOnJavaScriptThread` runs the closure synchronously on the current thread
    // (no hop), so these captures don't actually escape. They aren't `Sendable`, so silence
    // Swift 6's conservative cross-isolation check explicitly.
    nonisolated(unsafe) let unsafePropsPointer = propsObjectPointer
    nonisolated(unsafe) let unsafePropsDict = propsDict

    return runtime.assumeIsolatedOnJavaScriptThread {
      let decodeStart = mach_absolute_time()
      defer {
        ViewPropsBenchmark.decodeTicks += mach_absolute_time() - decodeStart
        ViewPropsBenchmark.decodePassCount += 1
      }

      let propsValue = JavaScriptValue.from(unsafeValuePointer: unsafePropsPointer, runtime: runtime)

      guard propsValue.isObject() else {
        return nil
      }
      let propsObject = propsValue.getObject()

      // Iterate the props object's OWN keys, not the full prop definition list. On a Fabric
      // update the rawProps object holds only the props that changed (it's the diff React
      // passes to `cloneNodeWithNewProps`), so this scales with the number of changed props
      // rather than the total number of declared props — a win for wide views where only a
      // few props change per update. (At initial mount the object holds all props.)
      let changedKeys = propsObject.getPropertyNames()

      var decoded: [String: Any] = [:]

      for key in changedKeys {
        guard let prop = unsafePropsDict[key] else {
          // Unknown prop (inherited from the base view / Yoga) — leave it for the legacy path.
          continue
        }
        let propValue = propsObject.getProperty(key)

        do {
          decoded[key] = try prop.decode(jsValue: propValue, appContext: appContext)
          ViewPropsBenchmark.decodedPropCount += 1
        } catch {
          // Skip props that fail to decode here; the legacy path can retry from the dictionary.
          continue
        }
      }

      if decoded.isEmpty {
        return nil
      }
      return DecodedViewProps(values: decoded)
    }
  }
}
