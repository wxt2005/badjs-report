(function(window, document){
    function createHttpRequest()
    {
        if(window.ActiveXObject){
            return new ActiveXObject("Microsoft.XMLHTTP");  
        }
        else if(window.XMLHttpRequest){
            return new XMLHttpRequest();  
        }  
    }
    function AliLogTracker(host,project,logstore)
    {
        this.uri_ = '//' + project + '.' + host + '/logstores/' + logstore + '/track?APIVersion=0.6.0';
        this.params_=new Array();
        this.httpRequest_ = createHttpRequest();
    }
    AliLogTracker.prototype = {
        push: function(key,value) {
            if(!key || !value) {
                return;
            }
            this.params_.push(key);
            this.params_.push(value);
        },
        logger: function()
        {
            var url = this.uri_;
            var k = 0;
            while(this.params_.length > 0)
            {
                if(k % 2 == 0)
                {
                    url += '&' + encodeURIComponent(this.params_.shift());
                }
                else
                {
                    url += '=' + encodeURIComponent(this.params_.shift());
                }
                ++k;
            }
            try
            {
                this.httpRequest_.open("GET",url,true);
                this.httpRequest_.send(null);
            }
            catch (ex) 
            {
                if (window && window.console && typeof window.console.log === 'function') 
                {
                    console.log("Failed to log to ali log service because of this exception:\n" + ex);
                    console.log("Failed log data:", url);
                }
            }
            
        }
    };
    window.Tracker = AliLogTracker;
})(window, document);

/*!
 * @module report
 * @author kael, chriscai
 * @date @DATE
 * Copyright (c) 2014 kael, chriscai
 * Licensed under the MIT license.
 */
var BJ_REPORT = (function(global) {
    if (global.BJ_REPORT) return global.BJ_REPORT;

    var logger;

    var _error = [];
    var _error_map = {};
    var _config = {
        id: 0, // 上报 id
        uin: 0, // user id
        url: "", // 上报 接口
        combo: 1, // 是否合并 !0-合并 0-不合并
        ext: null, // 扩展参数 用于自定义上报
        level: 4, // 错误级别 1-debug 2-info 4-error
        ignore: [], // 忽略某个错误, 支持 Regexp 和 Function
        random: 1, // 抽样 (0-1] 1-全量
        delay: 1000, // 延迟上报 combo 为 true 时有效
        submit: null, // 自定义上报方式
        repeat: 5 // 重复上报次数(对于同一个错误超过多少次不上报)
    };

    var _isOBJByType = function(o, type) {
        return Object.prototype.toString.call(o) === "[object " + (type || "Object") + "]";
    };

    var _isOBJ = function(obj) {
        var type = typeof obj;
        return type === "object" && !!obj;
    };

    var _isEmpty = function(obj) {
        if (obj === null) return true;
        if (_isOBJByType(obj, "Number")) {
            return false;
        }
        return !obj;
    };

    var orgError = global.onerror;
    // rewrite window.oerror
    global.onerror = function(msg, url, line, col, error) {
        var newMsg = msg;

        if (error && error.stack) {
            newMsg = _processStackMsg(error);
        }

        if (_isOBJByType(newMsg, "Event")) {
            newMsg += newMsg.type ?
                ("--" + newMsg.type + "--" + (newMsg.target ?
                    (newMsg.target.tagName + "::" + newMsg.target.src) : "")) : "";
        }

        report.push({
            msg: newMsg,
            target: url,
            rowNum: line,
            colNum: col
        });

        _send();
        orgError && orgError.apply(global, arguments);
    };

    var _processError = function(errObj) {
        try {
            if (errObj.stack) {
                var url = errObj.stack.match("https?://[^\n]+");
                url = url ? url[0] : "";
                var rowCols = url.match(":(\\d+):(\\d+)");
                if (!rowCols) {
                    rowCols = [0, 0, 0];
                }

                var stack = _processStackMsg(errObj);
                return {
                    msg: stack,
                    rowNum: rowCols[1],
                    colNum: rowCols[2],
                    target: url.replace(rowCols[0], "")
                };
            } else {
                //ie 独有 error 对象信息，try-catch 捕获到错误信息传过来，造成没有msg
                if (errObj.name && errObj.message && errObj.description) {
                    return {
                        msg: JSON.stringify(errObj)
                    };
                }
                return errObj;
            }
        } catch (err) {
            return errObj;
        }
    };

    var _processStackMsg = function(error) {
        var stack = error.stack
            .replace(/\n/gi, "")
            .split(/\bat\b/)
            .slice(0, 9)
            .join("@")
            .replace(/\?[^:]+/gi, "");
        var msg = error.toString();
        if (stack.indexOf(msg) < 0) {
            stack = msg + "@" + stack;
        }
        return stack;
    };

    var _error_tostring = function(error) {
        return JSON.stringify(error);
    };

    var _imgs = [];
    var _submit = function(error) {
        var meta = error._meta_;
        delete error._meta_;
        for(var prop in meta){
            if(meta.hasOwnProperty(prop)){
                logger.push(prop, meta[prop]);
            }
        }
        if(meta.type === 'js-error'){
             logger.push('message', JSON.stringify(error));
        }
        logger.push('time', new Date().getTime());
        logger.push('app', _config.app);
        logger.logger();
    };

    var _is_repert = function(error) {
        if (!_isOBJ(error)) return true;
        var msg = error.msg;
        if(!msg){
            return false;
        }
        var times = _error_map[msg] = (parseInt(_error_map[msg], 10) || 0) + 1;
        return times > _config.repeat;
    };

    var error_list = [];
    var comboTimeout = 0;
    var _send = function(isReoprtNow) {
        if (!_config.report) return;

        while (_error.length) {
            var isIgnore = false;
            var error = _error.shift();
            // 重复上报
            if (_is_repert(error)) continue;
            if (!error._meta_.type){
                continue;
            }
            if (_isOBJByType(_config.ignore, "Array")) {
                for (var i = 0, l = _config.ignore.length; i < l; i++) {
                    var rule = _config.ignore[i];
                    var error_str = JSON.stringify(error);
                    if ((_isOBJByType(rule, "RegExp") && rule.test(error_str)) ||
                        (_isOBJByType(rule, "Function") && rule(error, error_str))) {
                        isIgnore = true;
                        break;
                    }
                }
            }
            if (!isIgnore) {
                 _submit(error);
                _config.onReport && (_config.onReport(_config.id, error));
            }  
        }
    };

    var report = global.BJ_REPORT = {
        push: function(msg, meta) { // 将错误推到缓存池
            // 抽样
            if (Math.random() >= _config.random) {
                return report;
            }

            var data = _isOBJ(msg) ? _processError(msg) : {
                msg: msg
            };

            // ext 有默认值, 且上报不包含 ext, 使用默认 ext
            if (_config.ext && !data.ext) {
                data.ext = _config.ext;
            }

            data._meta_ = meta || {};

            _error.push(data);
            _send();
            return report;
        },
        report: function(msg) { // error report
            return this.error(msg);
        },
        error : function(msg, level){
            msg && report.push(msg, {
                'type' : 'js-error',
                'level' : level || 4,
                'url' : location.href,
                'count' : 1,
                'ua' : navigator.userAgent
            });
            _send(true);
            return report;
        },
        info: function(msg) { // info report
            return this.error(msg, 1)
        },
        debug: function(msg) { // debug report
            return this.error(msg, 2);
        },
        init: function(config) { // 初始化
            if (_isOBJ(config)) {
                for (var key in config) {
                    _config[key] = config[key];
                }
            }
            logger = new window.Tracker(_config.endpoint,_config.project,_config.logstore);
            // 没有设置id将不上报
            var id = parseInt(_config.id, 10);
            if (id) {
                // set default report url and uin
                if (/qq\.com$/gi.test(location.hostname)) {
                    if (!_config.url) {
                        _config.url = "//badjs2.qq.com/badjs";
                    }

                    if (!_config.uin) {
                        _config.uin = parseInt((document.cookie.match(/\buin=\D+(\d+)/) || [])[1], 10);
                    }
                }

                _config.report = (_config.url || "/badjs") +
                    "?id=" + id +
                    "&uin=" + _config.uin +
                    // "&from=" + encodeURIComponent(location.href) +
                    "&";
            }

            // if had error in cache , report now
            if (_error.length) {
                _send();
            }
            return report;
        },

        __onerror__: global.onerror
    };

    typeof console !== "undefined" && console.error && setTimeout(function() {
        var err = ((location.hash || "").match(/([#&])BJ_ERROR=([^&$]+)/) || [])[2];
        err && console.error("BJ_ERROR", decodeURIComponent(err).replace(/(:\d+:\d+)\s*/g, "$1\n"));
    }, 0);

    return report;

}(window));

if (typeof module !== "undefined") {
    module.exports = BJ_REPORT;
}
;(function(global) {

    if (!global.BJ_REPORT) {
        console.error("please load bg-report first");
        return;
    }

    var _onthrow = function(errObj) {
        global.BJ_REPORT.push(errObj);
    };

    var tryJs = {};
    global.BJ_REPORT.tryJs = function(throwCb) {
        throwCb && (_onthrow = throwCb);
        return tryJs;
    };

    // merge
    var _merge = function(org, obj) {
        for (var key in obj) {
            org[key] = obj[key];
        }
    };

    // function or not
    var _isFunction = function(foo) {
        return typeof foo === "function";
    };

    var timeoutkey;

    var cat = function(foo, args) {
        return function() {
            try {
                return foo.apply(this, args || arguments);
            } catch (error) {

                _onthrow(error);

                //some browser throw error (chrome) , can not find error where it throw,  so print it on console;
                if (error.stack && console && console.error) {
                    console.error("[BJ-REPORT]", error.stack);
                }

                // hang up browser and throw , but it should trigger onerror , so rewrite onerror then recover it
                if (!timeoutkey) {
                    var orgOnerror = global.onerror;
                    global.onerror = function() {};
                    timeoutkey = setTimeout(function() {
                        global.onerror = orgOnerror;
                        timeoutkey = null;
                    }, 50);
                }
                throw error;
            }
        };
    };

    var catArgs = function(foo) {
        return function() {
            var arg, args = [];
            for (var i = 0, l = arguments.length; i < l; i++) {
                arg = arguments[i];
                _isFunction(arg) && (arg = cat(arg));
                args.push(arg);
            }
            return foo.apply(this, args);
        };
    };

    var catTimeout = function(foo) {
        return function(cb, timeout) {
            // for setTimeout(string, delay)
            if (typeof cb === "string") {
                try {
                    cb = new Function(cb);
                } catch (err) {
                    throw err;
                }
            }
            var args = [].slice.call(arguments, 2);
            // for setTimeout(function, delay, param1, ...)
            cb = cat(cb, args.length && args);
            return foo(cb, timeout);
        };
    };

    /**
     * makeArgsTry
     * wrap a function's arguments with try & catch
     * @param {Function} foo
     * @param {Object} self
     * @returns {Function}
     */
    var makeArgsTry = function(foo, self) {
        return function() {
            var arg, tmp, args = [];
            for (var i = 0, l = arguments.length; i < l; i++) {
                arg = arguments[i];
                _isFunction(arg) && (tmp = cat(arg)) &&
                    (arg.tryWrap = tmp) && (arg = tmp);
                args.push(arg);
            }
            return foo.apply(self || this, args);
        };
    };

    /**
     * makeObjTry
     * wrap a object's all value with try & catch
     * @param {Function} foo
     * @param {Object} self
     * @returns {Function}
     */
    var makeObjTry = function(obj) {
        var key, value;
        for (key in obj) {
            value = obj[key];
            if (_isFunction(value)) obj[key] = cat(value);
        }
        return obj;
    };

    /**
     * wrap jquery async function ,exp : event.add , event.remove , ajax
     * @returns {Function}
     */
    tryJs.spyJquery = function() {
        var _$ = global.$;

        if (!_$ || !_$.event) {
            return tryJs;
        }

        var _add, _remove;
        if (_$.zepto) {
            _add = _$.fn.on, _remove = _$.fn.off;

            _$.fn.on = makeArgsTry(_add);
            _$.fn.off = function() {
                var arg, args = [];
                for (var i = 0, l = arguments.length; i < l; i++) {
                    arg = arguments[i];
                    _isFunction(arg) && arg.tryWrap && (arg = arg.tryWrap);
                    args.push(arg);
                }
                return _remove.apply(this, args);
            };

        } else if (window.jQuery) {
            _add = _$.event.add, _remove = _$.event.remove;

            _$.event.add = makeArgsTry(_add);
            _$.event.remove = function() {
                var arg, args = [];
                for (var i = 0, l = arguments.length; i < l; i++) {
                    arg = arguments[i];
                    _isFunction(arg) && arg.tryWrap && (arg = arg.tryWrap);
                    args.push(arg);
                }
                return _remove.apply(this, args);
            };
        }

        var _ajax = _$.ajax;

        if (_ajax) {
            _$.ajax = function(url, setting) {
                if (!setting) {
                    setting = url;
                    url = undefined;
                }
                makeObjTry(setting);
                if (url) return _ajax.call(_$, url, setting);
                return _ajax.call(_$, setting);
            };
        }

        return tryJs;
    };

    /**
     * wrap amd or commonjs of function  ,exp :  define , require ,
     * @returns {Function}
     */
    tryJs.spyModules = function() {
        var _require = global.require,
            _define = global.define;
        if (_define && _define.amd && _require) {
            global.require = catArgs(_require);
            _merge(global.require, _require);
            global.define = catArgs(_define);
            _merge(global.define, _define);
        }

        if (global.seajs && _define) {
            global.define = function() {
                var arg, args = [];
                for (var i = 0, l = arguments.length; i < l; i++) {
                    arg = arguments[i];
                    if (_isFunction(arg)) {
                        arg = cat(arg);
                        //seajs should use toString parse dependencies , so rewrite it
                        arg.toString = (function(orgArg) {
                            return function() {
                                return orgArg.toString();
                            };
                        }(arguments[i]));
                    }
                    args.push(arg);
                }
                return _define.apply(this, args);
            };

            global.seajs.use = catArgs(global.seajs.use);

            _merge(global.define, _define);
        }

        return tryJs;
    };

    /**
     * wrap async of function in window , exp : setTimeout , setInterval
     * @returns {Function}
     */
    tryJs.spySystem = function() {
        global.setTimeout = catTimeout(global.setTimeout);
        global.setInterval = catTimeout(global.setInterval);
        return tryJs;
    };

    /**
     * wrap custom of function ,
     * @param obj - obj or  function
     * @returns {Function}
     */
    tryJs.spyCustom = function(obj) {
        if (_isFunction(obj)) {
            return cat(obj);
        } else {
            return makeObjTry(obj);
        }
    };

    /**
     * run spyJquery() and spyModules() and spySystem()
     * @returns {Function}
     */
    tryJs.spyAll = function() {
        tryJs
            .spyJquery()
            .spyModules()
            .spySystem();
        return tryJs;
    };

}(window));
