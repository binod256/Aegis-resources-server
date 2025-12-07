"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveAliasArguments = exports.resolveUserArguments = exports.resolvePageArguments = exports.resolveArguments = void 0;
var analytics_core_1 = require("@segment/analytics-core");
/**
 * Helper for the track method
 */
function resolveArguments(eventName, properties, options, callback) {
    var _a;
    var args = [eventName, properties, options, callback];
    var name = (0, analytics_core_1.isPlainObject)(eventName) ? eventName.event : eventName;
    if (!name || !(0, analytics_core_1.isString)(name)) {
        throw new Error('Event missing');
    }
    var data = (0, analytics_core_1.isPlainObject)(eventName)
        ? (_a = eventName.properties) !== null && _a !== void 0 ? _a : {}
        : (0, analytics_core_1.isPlainObject)(properties)
            ? properties
            : {};
    var opts = {};
    if (!(0, analytics_core_1.isFunction)(options)) {
        opts = options !== null && options !== void 0 ? options : {};
    }
    if ((0, analytics_core_1.isPlainObject)(eventName) && !(0, analytics_core_1.isFunction)(properties)) {
        opts = properties !== null && properties !== void 0 ? properties : {};
    }
    var cb = args.find(analytics_core_1.isFunction);
    return [name, data, opts, cb];
}
exports.resolveArguments = resolveArguments;
/**
 * Helper for page, screen methods
 */
function resolvePageArguments(category, name, properties, options, callback) {
    var _a, _b;
    var resolvedCategory = null;
    var resolvedName = null;
    var args = [category, name, properties, options, callback];
    var strings = args.filter(analytics_core_1.isString);
    if (strings[0] !== undefined && strings[1] !== undefined) {
        resolvedCategory = strings[0];
        resolvedName = strings[1];
    }
    if (strings.length === 1) {
        resolvedCategory = null;
        resolvedName = strings[0];
    }
    var resolvedCallback = args.find(analytics_core_1.isFunction);
    var objects = args.filter(function (obj) {
        if (resolvedName === null) {
            return (0, analytics_core_1.isPlainObject)(obj);
        }
        return (0, analytics_core_1.isPlainObject)(obj) || obj === null;
    });
    var resolvedProperties = ((_a = objects[0]) !== null && _a !== void 0 ? _a : {});
    var resolvedOptions = ((_b = objects[1]) !== null && _b !== void 0 ? _b : {});
    return [
        resolvedCategory,
        resolvedName,
        resolvedProperties,
        resolvedOptions,
        resolvedCallback,
    ];
}
exports.resolvePageArguments = resolvePageArguments;
/**
 * Helper for group, identify methods
 */
var resolveUserArguments = function (user) {
    return function () {
        var _a, _b, _c;
        var args = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            args[_i] = arguments[_i];
        }
        var values = {};
        // It's a stack so it's reversed so that we go through each of the expected arguments
        var orderStack = [
            'callback',
            'options',
            'traits',
            'id',
        ];
        // Read each argument and eval the possible values here
        for (var _d = 0, args_1 = args; _d < args_1.length; _d++) {
            var arg = args_1[_d];
            var current = orderStack.pop();
            if (current === 'id') {
                if ((0, analytics_core_1.isString)(arg) || (0, analytics_core_1.isNumber)(arg)) {
                    values.id = arg.toString();
                    continue;
                }
                if (arg === null || arg === undefined) {
                    continue;
                }
                // First argument should always be the id, if it is not a valid value we can skip it
                current = orderStack.pop();
            }
            // Traits and Options
            if ((current === 'traits' || current === 'options') &&
                (arg === null || arg === undefined || (0, analytics_core_1.isPlainObject)(arg))) {
                values[current] = arg;
            }
            // Callback
            if ((0, analytics_core_1.isFunction)(arg)) {
                values.callback = arg;
                break; // This is always the last argument
            }
        }
        return [
            (_a = values.id) !== null && _a !== void 0 ? _a : user.id(),
            ((_b = values.traits) !== null && _b !== void 0 ? _b : {}),
            (_c = values.options) !== null && _c !== void 0 ? _c : {},
            values.callback,
        ];
    };
};
exports.resolveUserArguments = resolveUserArguments;
/**
 * Helper for alias method
 */
function resolveAliasArguments(to, from, options, callback) {
    if ((0, analytics_core_1.isNumber)(to))
        to = to.toString(); // Legacy behaviour - allow integers for alias calls
    if ((0, analytics_core_1.isNumber)(from))
        from = from.toString();
    var args = [to, from, options, callback];
    var _a = args.filter(analytics_core_1.isString), _b = _a[0], aliasTo = _b === void 0 ? to : _b, _c = _a[1], aliasFrom = _c === void 0 ? null : _c;
    var _d = args.filter(analytics_core_1.isPlainObject)[0], opts = _d === void 0 ? {} : _d;
    var resolvedCallback = args.find(analytics_core_1.isFunction);
    return [aliasTo, aliasFrom, opts, resolvedCallback];
}
exports.resolveAliasArguments = resolveAliasArguments;
//# sourceMappingURL=index.js.map