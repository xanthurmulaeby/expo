# JSI view-props decoding — implementation plan

Branch: `tsapeta/jsi-view-props-decoding`

## Goal

Decode Fabric view props directly from the live `jsi::Value` (on the JS thread, at
props-parse time) through the existing `AnyDynamicType.cast(jsValue:)` path — the same
path module-function arguments use — instead of flattening to `folly::dynamic` →
`NSDictionary` → `cast(_ value:)` on the main thread.

This routes records, shared objects, convertibles, and primitives through the JS-native
decoder. The decoded **Swift values** (not the `jsi::Value`s) are stored and applied to the
view later on the main thread.

The whole new path lives behind a compile-time flag so it can be benchmarked against the
current path with zero residual branch overhead.

## Scope / assumptions

- **Thread-safe target types only.** Per the audit, we only decode prop types whose
  `cast(jsValue:)` produces a value that is safe to create on the JS thread and hand to a
  `@MainActor` setter: primitives, `String`, `Data`, `NativeArrayBuffer`, records,
  convertibles, shared objects, enums, and containers of those.
- **Out of scope (fall back to the existing dictionary path):** `JavaScriptValue`,
  `TypedArray`, non-native `ArrayBuffer` (retain live JSI handles); `UIView` /
  SwiftUI-view props (main-thread-bound result / main-thread decode). These are routed to
  the legacy path per-prop, or simply left on the legacy path wholesale for the first
  benchmark cut.
- iOS Fabric only. macOS rides the same code (the `ExpoViewProps` ctor is shared) but the
  flag can stay off there initially.
- Old architecture / Paper is unaffected (separate path).

## Verified facts this plan rests on

- Props parsing runs **synchronously on the JS thread** when `RawProps` is `Mode::JSI`:
  `UIManagerBinding` `createNode`/`cloneNode` host functions →
  `UIManager::createNode` → `ConcreteComponentDescriptor::cloneProps` →
  `ExpoViewProps` ctor → `RawPropsParser::preparse`. No executor hop.
- `RawValue` stores `std::variant<folly::dynamic, std::pair<jsi::Runtime*, jsi::Value>>`;
  in `Mode::JSI` the JSI pair is populated during `preparse`.
- `RawProps` enumerates keys in `preparse` via `object.getPropertyNames(runtime)` — we can
  enumerate prop names without a pre-registered name list.
- `ContextContainer` is per-`RCTHost`, and `insert()` is `const` (mutable through a const
  ref), so it is injectable and readable in `PropsParserContext.contextContainer`.
- `ExpoReactNativeFactory.mm`'s `host:didInitializeRuntime:` (annotated `// [JS thread]`)
  has the `RCTHost`, the `jsi::Runtime&`, and the freshly created `EXAppContext` all in
  scope — the injection point for the AppContext holder.
- Component name (the dynamic class name, e.g. `ViewManagerAdapter_ExpoImage_<appId>`)
  encodes moduleName + viewName. AppContext resolves it:
  `appContext.moduleRegistry.get(moduleHolderForName:).definition.views[viewName]` →
  `ViewDefinition` → `propsDict()` (`[String: AnyViewProp]`).
- `JavaScriptValue(runtime, pointee)` internal init exists; the host-function arg path
  (`JavaScriptValuesBuffer`) is the established `jsi::Value` → `JavaScriptValue` bridge.

## The compile-time flag

`EXPO_JSI_VIEW_PROPS` — defined in one place (the podspec) and applied to both languages:

- Swift: add `-D EXPO_JSI_VIEW_PROPS` to `OTHER_SWIFT_FLAGS`.
- C++/ObjC++: add `EXPO_JSI_VIEW_PROPS=1` to `GCC_PREPROCESSOR_DEFINITIONS`.

Off (default): byte-for-byte the current behavior. On: the JS-thread-decode path, with
per-prop fallback to the legacy path for out-of-scope types.

---

## File-by-file changes

### 1. Read the whole-object JSI value from `RawProps` — NO RN patch (explicit-instantiation access)

Where a **live JSI-backed** value exists (verified):

| Mechanism | JSI-backed? | Name registration? | RN patch? |
|---|---|---|---|
| `setProp` iterator (ConcreteComponentDescriptor.h:140-150) | ❌ No — `static_cast<folly::dynamic>(rawProps)` (line 145) then `RawValue(dynamic)` (line 149). | No | No (but useless) |
| `rawProps.at(name,...)` → `RawValue` from `preparse` | ✅ Yes (RawPropsParser.cpp:138-139) | ✅ **Yes** (only registered `keys_` get materialized) | No |
| whole-object `rawProps.value_` (chosen) | ✅ Yes | **No** | No — accessed via explicit-instantiation hack |

**Chosen approach:** read the private `RawProps::value_` + `runtime_` directly via the
standard-legal explicit-template-instantiation idiom (explicit instantiation ignores access
control — [temp.explicit]/12, NOT UB). This avoids the `at()` path's name-registration
requirement entirely and lets us enumerate the props object's own keys exactly like
`preparse` does.

```cpp
// ExpoRawPropsAccess.h — steal private members without editing RN, no UB.
namespace expo {
  template <auto Member>
  struct RawPropsThief {
    friend facebook::jsi::Value& exValue(facebook::react::RawProps& r) { return r.*Member; }
  };
  template struct RawPropsThief<&facebook::react::RawProps::value_>;   // legal despite private
  facebook::jsi::Value& exValue(facebook::react::RawProps&);

  // (same idiom for runtime_ and mode_)
}
```

Then in the ctor (JS thread, flag on, `mode_ == Mode::JSI`):

```cpp
auto& runtime = *exRuntime(rawProps);
auto object = exValue(rawProps).asObject(runtime);
auto names = object.getPropertyNames(runtime);
for (each name) {
  auto value = object.getProperty(runtime, name);   // live jsi::Value
  // → shim → JavaScriptValue → cast(jsValue:)
}
```

**Fragility (accepted):** relies on `value_`/`runtime_`/`mode_` keeping their names and
types. If RN changes them, the explicit instantiation fails at **compile time** (loud, not
silent) — same fragility profile as a patch, but with zero diff in the vendored RN tree and
nothing to re-apply on RN bumps. The idiom is obscure; isolate it in one small header
(`ExpoRawPropsAccess.h`) with a comment explaining why.

Note we still use `RawValue`'s public `JsiValuePair` cast pattern if/when we read individual
`RawValue`s, but the primary path enumerates the whole object and never needs `at()`.

### 2. `ExpoViewProps` — capture/decoded-value storage + decode entry

**Files:**
- `packages/expo-modules-core/common/cpp/fabric/ExpoViewProps.h`
- `packages/expo-modules-core/common/cpp/fabric/ExpoViewProps.cpp`

- `.h`: add a storage member for decoded Swift values, opaque to C++. Since Swift `Any`
  can't live in `folly::dynamic`, store a retained ObjC container produced by the shim
  (e.g. `void* /* retained id */ decodedProps` or, cleaner, an
  `expo::DecodedPropsRef` RAII wrapper around a retained `id`). Keep `propsMap` for the
  legacy path / fallback props.

  ```cpp
  #ifdef EXPO_JSI_VIEW_PROPS
    // Decoded Swift prop values, produced on the JS thread at parse time.
    // Opaque retained handle owned by the ObjC++ decode shim.
    DecodedPropsRef decodedProps;
  #endif
  ```

- `.cpp`: in the ctor, under `#ifdef EXPO_JSI_VIEW_PROPS`:
  1. `auto holder = context.contextContainer.find<ExpoAppContextHolder>("expo.appContext");`
  2. If absent → fall through to existing `propsMapFromProps` (legacy).
  3. If present → enumerate the props object's keys via the whole-object access (item 1:
     `exValue(rawProps).asObject(runtime).getPropertyNames(...)` + `getProperty(...)`),
     and call the decode shim with: the component name (from the descriptor flavor /
     `context`), the per-prop live `jsi::Value`s, and the holder. The shim returns the
     retained decoded container, stored in `decodedProps`. No `at()`, no name registration.
  4. Out-of-scope prop types: the shim signals "not decoded here" per prop, and those keep
     flowing through `propsMap` (legacy) so `finalizeUpdates` still applies them.

  Note: enumerating per-prop JSI values requires `parse()` to have populated `RawValue`s.
  We piggyback on the parse RN already does; confirm `rawProps` is parsed before our read
  (it is — `cloneProps` calls `rawProps.parse(parser)` before the Props ctor body for
  inherited props; for our own enumeration we may call the preparse-equivalent or read the
  JSI object directly via the new accessor on the whole-object value).

### 3. New ObjC++ decode shim (the C++ ↔ Swift seam)

**New files:**
- `packages/expo-modules-core/ios/Fabric/ExpoViewPropsDecoder.h`
- `packages/expo-modules-core/ios/Fabric/ExpoViewPropsDecoder.mm`

- C++-callable surface (included from `ExpoViewProps.cpp`):

  ```cpp
  namespace expo {
  // Decodes the given JSI-backed props for `componentName` using the Swift
  // ViewDefinition reachable from the AppContext holder. Returns a retained
  // container of decoded Swift values (boxed), or nullptr if nothing decodable.
  // MUST be called on the JS thread.
  DecodedPropsRef decodeViewProps(
    const std::string& componentName,
    jsi::Runtime& runtime,
    const std::unordered_map<std::string, const jsi::Value*>& jsiProps,
    id appContextHolder
  );
  }
  ```

- `.mm` implementation:
  1. Unwrap `appContextHolder` → `AppContext`.
  2. For each prop name + `jsi::Value`: wrap as a Swift `JavaScriptValue`
     (`JavaScriptValue(jsRuntime, *value)` — via the same mechanism as
     `JavaScriptValuesBuffer`), then call into Swift to run the prop's `cast(jsValue:)`.
  3. The actual per-prop decode is a small Swift entry point (next item) exposed to ObjC.
     The `.mm` is the place that legally touches both `jsi::Value` and the Swift bridge.
  4. Box decoded values into an `NSMutableDictionary` (values wrapped so `Any` survives) and
     return it retained.

  The shim is where the `@JavaScriptActor` isolation is asserted (we are on the JS thread).

### 4. Swift per-prop decode entry point + apply path

**File:** `packages/expo-modules-core/ios/Fabric/ExpoFabricView.swift`

- Add a static/class Swift method callable from the shim that, given an `AppContext`,
  component identity (moduleName/viewName), a prop name, and a `JavaScriptValue`, resolves
  the `ConcreteViewProp` from
  `appContext.moduleRegistry.get(moduleHolderForName:).definition.views[viewName].propsDict()`
  and returns the decoded `Any` (or signals "skip — not JS-thread-decodable" for
  out-of-scope types). This requires a way to ask a prop's `AnyDynamicType` whether it is
  JS-thread-decodable (item 5).

- Split prop application so decode and set are separable:
  - Today `ConcreteViewProp.set(value:onView:appContext:)` does `cast` + `setter` together
    under `MainActor.assumeIsolated`.
  - Add a main-thread apply entry: given an already-decoded `Any`, run only the
    `@MainActor` `setter(view, value)` (skip the cast). The JS-thread decode produced the
    value; main only applies.

- `updateProps` (main): under `EXPO_JSI_VIEW_PROPS`, read the decoded values stored on the
  props object (surfaced through `ExpoFabricViewObjC` — item 6) and apply via the new
  main-thread apply entry. Props that fell back stay on the existing dictionary apply.

### 5. `AnyDynamicType` — JS-thread-decodable classifier

**Files:** `packages/expo-modules-core/ios/Core/DynamicTypes/AnyDynamicType.swift`
and the individual `Dynamic*Type.swift` files.

- Add `var isJSThreadDecodable: Bool { get }` to the protocol with a safe default
  (`false` — conservative). Override `true` on the safe set:
  Bool, Number, String, Raw, Void, Data, Convertible (incl. Record), Codable (pending a
  quick `JSValueDecoder` confirm), SharedObject, NativeArrayBuffer variant, Enum.
  Containers (`Array`, `Dictionary`, `Optional`, `Either`, `ValueOrUndefined`) return the
  AND of their inner type(s).
- `false` on: `DynamicJavaScriptType`, `DynamicTypedArrayType`, `ArrayBuffer` (non-native),
  `DynamicViewType`, `DynamicSwiftUIViewType`.
- The shim/decoder consults this per prop to decide decode-vs-fallback.

### 6. `ExpoFabricViewObjC` — surface decoded props to Swift

**Files:**
- `packages/expo-modules-core/ios/Fabric/ExpoFabricViewObjC.h`
- `packages/expo-modules-core/ios/Fabric/ExpoFabricViewObjC.mm`

- In `finalizeUpdates:` under `EXPO_JSI_VIEW_PROPS`: instead of (or alongside) building the
  `NSDictionary` via `convertFollyDynamicToId`, read `newProps.decodedProps` and pass the
  decoded container to a new Swift override (e.g. `applyDecodedProps:` mirroring the
  existing `updateProps:` ObjC-override mechanism). Props that fell back to `propsMap` are
  still passed through the existing `updateProps:` call.
- Keep `supportsPropWithName:` filtering as-is.

### 7. Inject the AppContext holder into the host `ContextContainer`

**File:** `packages/expo/ios/AppDelegates/ExpoReactNativeFactory.mm`

- In `host:didInitializeRuntime:` (already on the JS thread, already creates
  `_appContext`): obtain the host's `ContextContainer` and insert a weak holder:

  ```objcpp
  // After _appContext is created and wired:
  auto contextContainer = /* host's ContextContainer (via RCTHost / EXHostWrapper) */;
  contextContainer->insert("expo.appContext",
                           expo::ExpoAppContextHolder{ /* weak */ _appContext });
  ```

- `ExpoAppContextHolder` is a tiny copyable C++ struct holding a weak ObjC ref
  (mirrors the existing weak injection in `ExpoFabricView.inject(appContext:)`), defined in
  a shared header so both the factory and `ExpoViewProps.cpp` can `find<>` it.

**Open item:** confirm how to get the `ContextContainer` from `RCTHost` (direct accessor,
or via the scheduler/surfacePresenter, or add an accessor on `EXHostWrapper`). Verify
ordering: `didInitializeRuntime` must precede any component props construction (it should —
views mount after runtime init; add a debug assert).

### 8. Podspec — define the flag

**File:** `packages/expo-modules-core/ExpoModulesCore.podspec`

- Add `EXPO_JSI_VIEW_PROPS=1` to `GCC_PREPROCESSOR_DEFINITIONS` and `-D EXPO_JSI_VIEW_PROPS`
  to `OTHER_SWIFT_FLAGS`, gated so it's easy to flip for benchmarks (e.g. driven by an env
  var read in the podspec, or commented toggle). Keep both in sync from this single source.

---

## Build / test notes

- After adding the new `.h/.mm` files, **reinstall pods** (new iOS source files).
- No RN fork/patch — the JSI value is read through `RawValue`'s public cast API (item 1).
- `ExpoModulesJSI` is a prebuilt xcframework — the `jsi::Value` → `JavaScriptValue` bridge
  must use APIs already exported by it (the internal init is in-package; the shim calls it
  via the package's Swift/ObjC surface, not by reaching into JSI C++ directly from
  expo-modules-core).

## Benchmark procedure

1. Build with flag **off**, measure prop-update throughput on a record-heavy /
   primitive-heavy view (e.g. a list re-rendering many props/frame).
2. Build with flag **on**, same scenario.
3. Compare. Expectation to validate: on-path avoids the
   `folly::dynamic`→`NSDictionary`→`cast(_ value:)` round-trip and the double walk, decoding
   once on the JS thread. Watch for the new cost: JS-thread work moves off main (good for
   main-thread responsiveness) but adds JS-thread load — measure both threads.

## Remaining unknowns to close during implementation

1. `RCTHost` → `ContextContainer` accessor (item 7).
2. RESOLVED (see item 1): use the whole-object `RawProps::value_` via the
   explicit-instantiation access hack and enumerate keys ourselves — no `at()`, no
   name-registration dance, no RN patch. (`at()` would work but only for parser-registered
   names; `setProp` iterator is dynamic-backed and unusable.) Verify the hack compiles under
   the project's C++ standard/toolchain and that `value_` is populated (`Mode::JSI`) at our
   call point.
3. `JSValueDecoder` confirm for `DynamicCodableType` (does it copy out, or retain a
   `JavaScriptValue`?) before marking Codable JS-thread-decodable (item 5).
4. Exact boxing strategy for decoded `Any` across the ObjC++ boundary (item 3/6).

## Out-of-scope follow-ups (not this change)

- SwiftUI view-props path (`SwiftUIVirtualViewObjC*.mm`) has its own
  `convertFollyDynamicToId`; would need parallel treatment.
- Extending the safe set to JSI-handle types via eager copy-out (like `Data` /
  `NativeArrayBuffer` already do).

---

## Benchmark methodology

### What this change actually affects

The change fires **only** in the Fabric view-props pipeline: `cloneProps` (JS thread, decode)
and `finalizeUpdates`/`updateProps` (main thread, apply). It does **nothing** for module
function arguments — so the existing `passthroughRecord`/`foldArray` micro-benchmarks would
show no difference and are the wrong harness. The benchmark must mount an Expo view and update
its props repeatedly.

It **moves** work (decode: main → JS thread) and on the flag-on path **adds** a JSI round-trip
while **removing** the `folly::dynamic`→`NSDictionary`→`cast` round-trip. A single wall-clock
number is therefore misleading — measure the JS-thread cost and main-thread cost separately.

### Three measurement axes

1. **Native micro-timing** (cleanest signal, React noise excluded). `EXViewPropsBenchmark`
   accumulates `mach_absolute_time` around decode (`decodeProps`, JS thread) and apply
   (`applyDecodedProps` + legacy `updateProps`, main thread), plus decoded/legacy prop counts.
   Read via `BenchmarkingModule.getViewPropsBenchmark()`. Flag **off** → `decodeMs == 0`, all
   cost in `applyMs` (legacy `set` = cast + setter on main). Flag **on** → cost split into
   `decodeMs` (JS thread) + `applyMs` (just the setter on main). The win is `applyMs` dropping.
2. **Instruments Time Profiler** (thread attribution — the real story). Capture a `.trace`
   while running the loop, flag on vs off. Use the `instruments-trace-analysis` skill to
   aggregate samples per thread; confirm main-thread time drops even if JS-thread time rises.
3. **End-to-end frame stats** (does it matter). Watch dropped frames during a sustained
   prop-update animation, on vs off. If main-thread savings don't reduce jank, it's not worth
   shipping regardless of micro numbers.

### Harness (built)

- Native view `BenchmarkView` (in the `benchmarking` module): record prop (`style`), array
  prop (`values`), `UIColor`, and several primitives/strings — all JS-thread-decodable, so the
  fast path actually triggers. Setters are near-no-ops (we measure decode/apply, not render).
- `ViewPropsBenchmarkScreen`: mounts the view, drives `WARMUP` + `ITERATIONS` prop-update
  passes via `requestAnimationFrame` (every value changes each pass so change-detection never
  short-circuits), resets counters after warmup, reports decode/apply totals + per-pass µs.

### Procedure

1. **Release config, physical device.** Debug Swift and the simulator are not representative.
2. `export EXPO_JSI_VIEW_PROPS=1 RCT_NEW_ARCH_ENABLED=1 && pod install`, build, run the screen,
   tap "Run benchmark", record results. Repeat ≥3×, take the median.
3. Rebuild with `EXPO_JSI_VIEW_PROPS` unset (`pod install` again), repeat.
4. Compare: expect flag-on `applyMs` < flag-off `applyMs` (main-thread win); flag-on adds
   `decodeMs` on the JS thread (acceptable if main drops and the JS thread isn't the bottleneck).
5. For axis 2, capture a Time Profiler trace during step 2/3 and run the trace-analysis skill.

### Controls / traps

- Warm up (component registration, dynamic class allocation, props-registry population happen
  on first mount). Measured window excludes warmup.
- Every prop value must change each pass, or `previousProps` short-circuits both paths.
- Prop-type mix matters: a view with only out-of-scope props (functions, typed arrays) shows
  no difference — the benchmark view deliberately uses in-scope types.
- React/Fabric commit overhead dwarfs decode; that's why axis 1 times only the native
  decode/apply windows rather than the full JS→pixels loop.
- Counters aren't synchronized; the harness drives passes serially so races don't matter.

### Open

- Not yet run. Needs a physical-device Release build and the on/off comparison above.
- `host.surfacePresenter.contextContainer` nil-at-init ordering still unverified at runtime; if
  the holder never gets injected, `decodePassCount` stays 0 (a clear signal the path is inert).
