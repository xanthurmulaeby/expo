// Copyright 2022-present 650 Industries. All rights reserved.

#pragma once

#ifdef __cplusplus

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/core/ShadowNode.h>

#include "ExpoViewShadowNode.h"

#ifdef EXPO_JSI_VIEW_PROPS
#include <react/utils/ContextContainer.h>

#include "ExpoAppContextHolder.h"
#include "ExpoRawPropsAccess.h"
#include "ExpoViewPropsDecoder.h"
#endif

namespace expo {

template<typename ShadowNodeType = ExpoViewShadowNode<ExpoViewProps, ExpoViewState>>
class ExpoViewComponentDescriptor
  : public facebook::react::ConcreteComponentDescriptor<ShadowNodeType> {
public:
  using Flavor = std::shared_ptr<std::string const>;

  ExpoViewComponentDescriptor(
    facebook::react::ComponentDescriptorParameters const &parameters,
    react::RawPropsParser &&rawPropsParser = {}
  ) : facebook::react::ConcreteComponentDescriptor<ShadowNodeType>(parameters, std::move(rawPropsParser)) {}

  facebook::react::ComponentHandle getComponentHandle() const override {
    return reinterpret_cast<facebook::react::ComponentHandle>(getComponentName());
  }

  facebook::react::ComponentName getComponentName() const override {
    return std::static_pointer_cast<std::string const>(this->flavor_)->c_str();
  }

#ifdef EXPO_JSI_VIEW_PROPS
  /**
   Overrides prop cloning to additionally decode view props straight from their JavaScript
   values on the JavaScript thread (this runs synchronously during `createNode`/`cloneNode`,
   on the JS thread, while `rawProps` still holds the live `jsi::Value`). The decoded values
   are stashed on the resulting `ExpoViewProps` and applied to the view later on the main
   thread. Props that aren't safe to decode on the JS thread are left to the legacy
   `folly::dynamic` path. Falls back silently to the base behavior when the props aren't
   JSI-backed or the app context can't be resolved.
   */
  facebook::react::Props::Shared cloneProps(
    const facebook::react::PropsParserContext &context,
    const facebook::react::Props::Shared &props,
    facebook::react::RawProps rawProps
  ) const override {
    // Decode *before* delegating to the base implementation, which consumes `rawProps` by
    // value (moves it in) — afterwards its `jsi::Value` would be gone. We're on the JS thread
    // here (synchronous `createNode`/`cloneNode`), so the live JSI value is safe to read.
    void *decoded = nullptr;
    if (rawPropsIsJSIBacked(rawProps)) {
      if (auto holderPtr = context.contextContainer.find<ExpoAppContextHolder>(
            ExpoAppContextHolder::kContextContainerKey)) {
        decoded = decodeViewProps(
          getComponentName(),
          *rawPropsRuntime(rawProps),
          rawPropsValue(rawProps),
          holderPtr.value());
      }
    }

    auto cloned = facebook::react::ConcreteComponentDescriptor<ShadowNodeType>::cloneProps(
      context, props, std::move(rawProps));

    if (decoded != nullptr) {
      if (const auto expoProps = std::dynamic_pointer_cast<const ExpoViewProps>(cloned)) {
        // Adopt the retained Swift object into a shared_ptr that releases it via
        // CFBridgingRelease (an ObjC bridge call) when the last props clone is gone.
        expoProps->decodedProps = makeDecodedPropsHandle(decoded);
      } else {
        // Couldn't attach it; release to avoid leaking the retained Swift object.
        makeDecodedPropsHandle(decoded);
      }
    }
    return cloned;
  }
#endif // EXPO_JSI_VIEW_PROPS

  void adopt(facebook::react::ShadowNode &shadowNode) const override {
    react_native_assert(dynamic_cast<ShadowNodeType *>(&shadowNode));

    const auto snode = dynamic_cast<ShadowNodeType *>(&shadowNode);
    const auto state = snode->getStateData();

    auto width = state._width;
    auto height = state._height;

    if (!isnan(width) || !isnan(height)) {
      auto const &props = *std::static_pointer_cast<const facebook::react::ViewProps>(
        snode->getProps());

      // The node has width and/or height set as style props, so we should not override it
      auto widthProp = props.yogaStyle.dimension(facebook::yoga::Dimension::Width);
      auto heightProp = props.yogaStyle.dimension(facebook::yoga::Dimension::Height);

      if (widthProp.value().isDefined()) {
        // view has fixed dimension size set in props, so we should not autosize it in that axis
        width = widthProp.value().unwrap();
      }
      if (heightProp.value().isDefined()) {
        height = heightProp.value().unwrap();
      }

      snode->setSize({width, height});
    }

    // handle layout style prop update
    auto styleWidth = state._styleWidth;
    auto styleHeight = state._styleHeight;

    if (!isnan(styleWidth) || !isnan(styleHeight)) {
      auto const &props = *std::static_pointer_cast<const facebook::react::ViewProps>(
        snode->getProps());

      auto &style = const_cast<facebook::yoga::Style &>(props.yogaStyle);
      bool changedStyle = false;

      if (!isnan(styleWidth)) {
        style.setDimension(facebook::yoga::Dimension::Width,
                           facebook::yoga::StyleSizeLength::points(styleWidth));
        changedStyle = true;
      }

      if (!isnan(styleHeight)) {
        style.setDimension(facebook::yoga::Dimension::Height,
                           facebook::yoga::StyleSizeLength::points(styleHeight));
        changedStyle = true;
      }

      // Update yoga props and dirty layout if we changed the style
      if (changedStyle) {
        snode->updateYogaProps();
        snode->dirtyLayout();
      }
    }
    facebook::react::ConcreteComponentDescriptor<ShadowNodeType>::adopt(shadowNode);
  }
};

} // namespace expo

#endif // __cplusplus
