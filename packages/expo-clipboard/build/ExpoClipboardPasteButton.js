import { requireNativeView } from 'expo';
import { Platform } from 'react-native';
let ExpoClipboard;
if (Platform.OS === 'ios') {
    ExpoClipboard = requireNativeView('ExpoClipboard');
}
export default ExpoClipboard;
//# sourceMappingURL=ExpoClipboardPasteButton.js.map