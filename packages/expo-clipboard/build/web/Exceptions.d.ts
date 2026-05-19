import { CodedError } from 'expo';
export declare class ClipboardUnavailableException extends CodedError {
    constructor();
}
export declare class CopyFailureException extends CodedError {
    constructor(cause: string);
}
export declare class PasteFailureException extends CodedError {
    constructor(cause: string);
}
export declare class NoPermissionException extends CodedError {
    constructor();
}
//# sourceMappingURL=Exceptions.d.ts.map