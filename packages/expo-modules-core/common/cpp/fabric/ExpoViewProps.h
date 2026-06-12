// Copyright 2022-present 650 Industries. All rights reserved.

#pragma once

#ifdef __cplusplus

#include <memory>

#include <folly/dynamic.h>
#include <react/renderer/components/view/ViewProps.h>
#include <react/renderer/core/PropsParserContext.h>

#ifdef __APPLE__
#include <TargetConditionals.h>
#endif

// macOS ViewProps doesn't support filterObjectKeys parameter
#if defined(TARGET_OS_OSX) && TARGET_OS_OSX
#define EXPO_VIEW_PROPS_SUPPORTS_FILTER_OBJECT_KEYS 0
#else
#define EXPO_VIEW_PROPS_SUPPORTS_FILTER_OBJECT_KEYS 1
#endif

namespace expo {

class ExpoViewProps : public facebook::react::ViewProps {
public:
  ExpoViewProps() = default;

  ExpoViewProps(
    const facebook::react::PropsParserContext &context,
    const ExpoViewProps &sourceProps,
    const facebook::react::RawProps &rawProps,
    const std::function<bool(const std::string &)> &filterObjectKeys = nullptr
  );

#pragma mark - Props

  /**
   A map with props stored as `folly::dynamic` objects.
   */
  std::unordered_map<std::string, folly::dynamic> propsMap;

#ifdef EXPO_JSI_VIEW_PROPS
  /**
   View props that were decoded straight from their JavaScript values on the JavaScript
   thread during props parsing (see the JSI view-props decoding design). Type-erased to a
   `void` shared pointer that retains a Swift `EXDecodedViewProps` object; the deleter
   releases it via `CFBridgingRelease`. Set by the component descriptor's `cloneProps`,
   read on the main thread in `finalizeUpdates:`.

   `shared_ptr` so the (copyable, value-semantic) props object can be cloned by Fabric while
   the decoded container is released exactly once. `mutable` because it is filled in by the
   component descriptor's `cloneProps` after the props object is already held as `const`.
   */
  mutable std::shared_ptr<void> decodedProps;
#endif // EXPO_JSI_VIEW_PROPS
};

} // namespace expo

#endif // __cplusplus
