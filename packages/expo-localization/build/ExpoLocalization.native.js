import { requireNativeModule } from 'expo';
const ExpoLocalizationModule = requireNativeModule('ExpoLocalization');
export function addLocaleListener(
// NOTE(@kitten): We never use the event's data
listener) {
    return ExpoLocalizationModule.addListener('onLocaleSettingsChanged', listener);
}
export function addCalendarListener(
// NOTE(@kitten): We never use the event's data
listener) {
    return ExpoLocalizationModule.addListener('onCalendarSettingsChanged', listener);
}
/**
 * @deprecated use subscription.remove() instead.
 */
export function removeSubscription(subscription) {
    subscription.remove();
}
export default ExpoLocalizationModule;
//# sourceMappingURL=ExpoLocalization.native.js.map