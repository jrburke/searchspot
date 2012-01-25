/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Jetpack.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2010
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Bryan Clark <clarkbw>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

"use strict";

if (!require("api-utils/xul-app").is("Firefox")) {
  throw new Error([
    "The search engine module currently supports only Firefox.  In the future ",
    "we would like it to support other applications, however.  Please see ",
    "https://bugzilla.mozilla.org/show_bug.cgi?id=jetpack-panel-apps ",
    "for more information."
  ].join(""));
}

const { Cc, Ci } = require("chrome");
const { Trait } = require('traits');
const { EventEmitter } = require("events");
const ObserverService = require("observer-service");
const SimpleStorage = require("simple-storage");
const PrivateBrowsing = require("private-browsing");
const data = require("self").data;
const URL = require("url");
const xhr = require("xhr");
const PageMod = require("page-mod");
const { Geolocation } = require("geolocation");

const DATA_XML = 1;

const DEFAULT_TAG = "_default";
const FOUND_TAG = "_found";

const URLTYPE_SEARCH_HTML  = "text/html",
      URLTYPE_SUGGEST_JSON = "application/x-suggestions+json";

var SearchService = Cc["@mozilla.org/browser/search-service;1"].
                    getService(Ci.nsIBrowserSearchService);

// Mapping Search Engine Names to their Suggest URLs
var SuggestMap = {};

const SystemSearchEngine = Trait.compose({
  _engine : null,
  get nsISearchEngine() this._engine,

  constructor: function SearchEngine(nsISearchEngine) {
    this._engine = nsISearchEngine.QueryInterface(Ci.nsISearchEngine);
  },

  get alias() this._engine.alias,
  get description() this._engine.description,
  get hidden() this._engine.hidden,
  get iconURI() this._engine.iconURI,
  get icon() {
    return (this._engine.iconURI)? this._engine.iconURI.spec : null;
  },
  get name() this._engine.name,
  get searchForm() this._engine.searchForm,
  get type() this._engine.type,

  _getSubmission : function _getSubmission(terms, location, type) {
    var submission = this._engine.getSubmission(terms, type), url = null;
    if (!submission) {
      return null;
    }
    url = submission.uri.spec;
    // We accept location searches so we need to replace the location param with the location given
    if (location) {
      url = url.replace("{searchLocation}", encodeURIComponent(location));
    }
    return url;
  },

  getSubmission : function getSubmission(terms, location) {
    return this._getSubmission(terms, location, URLTYPE_SEARCH_HTML)
  },
  getSuggestion : function getSuggestion(terms, location) {
    var url = null;
    // If this is part of our map hack then use that
    if (SuggestMap[this.name]) {
      // Do our own submission engine
      url = SuggestMap[this.name].replace("{searchTerms}", encodeURIComponent(terms));
      url = url.replace("{searchLocation}", encodeURIComponent(location));
    } else {
      url = this._getSubmission(terms, location, URLTYPE_SUGGEST_JSON);
    }
    return url;
  },
  addParam : function addParam(params) {
    try {
      this._engine.addParam(params.name, params.value, params.responseType);
    } catch(ex) { throw(ex); }
  },
  addSuggest: function addSuggest(url) {
    try {
      this.addParam({"name" : "suggest", "value" : url, "responseType" : URLTYPE_SUGGEST_JSON});
    } catch (ignore) {
      // Map these out because read-only engines will barf at the param addition
      SuggestMap[this.name] = url;
      // notify watchers that this engine has changed
      ObserverService.notify("browser-search-engine-modified", this.nsISearchEngine, "engine-changed");
    }
  },
  supportsResponseType : function supportsResponseType(type) {
    return this._engine.supportsResponseType(type);
  },
  toJSON : function toJSON() {
    return { name : this.name,
             icon : this.icon,
             description: this.description,
             search : this.searchForm
            };
  }
});

/*
  Search Engine v2.0
  {
    title : "Google",
    icon  : uri,
    engine : uri,
    site : uri,
    tags : ["search", "default"],
    getSubmission(terms, location) {},
    getSuggestion(terms, location) {},
  }

  We use the backend to do the XML parsing for us

*/
const SearchEngine = Trait.compose({

  _systemEngineInit : function(systemSearchEngine) {
    this._queryURL = decodeURIComponent(systemSearchEngine.getSubmission("{searchTerms}", "{searchLocation}"));
    this._suggestionURL = decodeURIComponent(systemSearchEngine.getSuggestion("{searchTerms}", "{searchLocation}") || "");
    this._name = systemSearchEngine.name;
    this._icon = systemSearchEngine.icon;
    var site = URL.URL(systemSearchEngine.searchForm);
    this._site = URL.URL(site.toString().replace(site.path, ""));
    this._host = this._site.toString();
  },

  constructor: function SearchEngine(site, name, query, suggestion, icon, tags, system) {
    // objects created from a SystemSearchEngine will only have the tags
    if (system) {
      this._systemEngineInit(system);
    } else {
      this._site = URL.URL(site);
      this._host = site.replace(this._site.path, "");
      this._name = name;
      this._queryURL = query;
      this._suggestionURL = suggestion;
      this._icon = icon;
    }

    this._tags = tags;
  },

  get site() this._site.toString(),
  get host() this._host,
  get name() this._name,
  get queryURL() this._queryURL,
  get suggestionURL() this._suggestionURL || "",
  get icon() this._icon,

  get tags() this._tags,
  appendTag : function appendTag(tag) {
    this._tags.push(tag);
  },
  removeTag : function removeTag(tag) {
    this._tags.splice(this._tags.indexOf(tag), 1);
  },

  _getURL : function _getURL(url, terms, location) {
    return url.replace("{searchLocation}",
                       encodeURIComponent(location)).
               replace("{searchTerms}",
                       encodeURIComponent(terms));
  },

  getSubmission : function getSubmission(terms, location) {
    if (!location) {
      location = Geolocation.formatted_address;
    }
    return this._getURL(this.queryURL, terms, location);
  },
  getSuggestion : function getSuggestion(terms, location) {
    if (!location) {
      location = Geolocation.formatted_address;
    }
    return this._getURL(this.suggestionURL, terms, location);
  },
  toJSON : function toJSON() {
    return { name : this.name,
             site : this.site.toString(),
             host : this.host,
             tags : this.tags,
             queryURL: this.queryURL,
             suggestionURL : this.suggestionURL,
             icon : this.icon
            };
  }
});


if (PrivateBrowsing.active) {
  console.error("PRIVATE BROWSING!!");
}

const SystemBrowserSearchEngines = EventEmitter.compose({
  _emit: EventEmitter.required,
  on: EventEmitter.required,

  constructor : function BrowserSearchEngines() {
    ObserverService.add("browser-search-engine-modified", this._observer, this);
    require("unload").when(function () { ObserverService.remove("browser-search-engine-modified", this._observer.bind(this)); }.bind(this));

    // Add in some suggestions for engines we know already work but aren't listed
    this.get("Wikipedia (en)").addSuggest("http://en.wikipedia.org/w/api.php?action=opensearch&search={searchTerms}");
    this.get("Amazon.com").addSuggest("http://completion.amazon.com/search/complete?method=completion&search-alias=aps&mkt=1&q={searchTerms}");
  },

  add : function add(engine) {
    SearchService.addEngineWithDetails(engine.name, engine.icon, engine.alias, engine.description, engine.method, engine.url);
    if (engine.suggest) {
      this.get(engine.name).addSuggest(engine.suggest);
    }
    
  },

  // You are required as the caller of this function to ensure that the URL being
  // passed actually points to an OpenSearch XML file otherwise Firefox will
  // prompt the user with a dialog complaining that it can't find the Plugin
  addByURL : function addByURL(url) {
    console.log("addByURL", url);
    SearchService.addEngine(url, DATA_XML, "", false);
  },

  remove : function remove(engine) {
    SearchService.removeEngine(engine.nsISearchEngine);
  },

  get : function get(name) {
    var engine = SearchService.getEngineByName(name) || SearchService.getEngineByAlias(name);
    if (engine) {
      return SystemSearchEngine(engine);
    }
    return null;
  },

  getDefaults : function getDefaults() {
    var engines = [];
    for each (let engine in SearchService.getDefaultEngines()) {
      engines.push(SystemSearchEngine(engine));
    }
    return engines;
  },

  getVisible : function getVisible() {
    var engines = [];
    for each (let engine in SearchService.getVisibleEngines()) {
      engines.push(SystemSearchEngine(engine));
    }
    return engines;
  },

  // WTF? this should be (subject, data) but that's not what we're getting
  _observer : function _observer(data, subject) {
    var engine = SystemSearchEngine(data); // data = nsISearchEngine

    // This is the removal of a non-default installed engine, defaults are "changed"
    if ("engine-removed" == subject) {
      this._emit("removed", engine);

    // This is the removal of a non-default installed engine, defaults are "changed"
    } else if ("engine-added" == subject) {
      console.log("added", engine.name);
      this._emit("added", engine);

    // This is a grab bag of possible events from edits to removal depending on the type of engine
    } else if ("engine-changed" == subject) {

        // removing a default engine only actually hides it, they are not removed
        if (engine.hidden) {
          this._emit("removed", engine);
        } else {
          this._emit("changed", engine);
        }
      //dump("name: " + engine.name + "\n");
      //dump("description: " + engine.description + "\n");

    // This sets the current engine in use
    } else if ("engine-current" == subject) {
      this._emit("current", engine);
    }
  }

})();



const BrowserSearchEngines = EventEmitter.compose({
  _emit: EventEmitter.required,
  on: EventEmitter.required,

  _geolocationAllowed : false,

  get tags() {
    var tags = [];
    for (var t in this._engines) {
      tags.push(t);
    }
    return tags;
  },

  set geolocation(allow) {
    Geolocation.allowed = this._geolocationAllowed = allow;
  },

  get geolocation() {
    if (!this._geolocationAllowed) {
      this._geolocationAllowed = Geolocation.allowed;
    }
    return this._geolocationAllowed;
  },

  _engines : { },

  constructor : function BrowserSearchEngines() {
    if (!SimpleStorage.storage.engines) {
      SimpleStorage.storage.engines = {};
      this._init();
    }

    // Searches for these link references
     //<link rel="search"
     //      type="application/opensearchdescription+xml" 
     //      href="http://example.com/comment-search.xml"
     //      title="Comments search" />
    PageMod.PageMod({
      include: "*",
      contentScriptWhen: 'end',
      contentScriptFile: data.url("browser-search-engine-pagemod.js"),
      onAttach: function(worker) { this._onAttach(worker); }.bind(this)
    });

    Geolocation.once("address", function() {
      // Add Yelp to our Search Engines once we have Geolocation
      SystemBrowserSearchEngines.add({
                    "name" : "Yelp",
                    "icon" : "data:image/x-icon;base64,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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsQCQEAEhsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsMAQAAAAAMGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbDgAAAAAAAAwbGxsbGxoFCxsbGxsbGxsbGxsbGxsbGxsXAQAAAAAADBsbGxsbBQAACRsbGxsbGxsbGxsbGxsbGxsVAAAAAAAMGxsbGw4AAAAACRsbGxsbGxsbGxsbGxsbGxsPAAAAAAwbGxsYAQAAAAAAEhsbGxsbGxsbGxsbGxsbGxsPAAAADBsbGwcAAAAAAAACGxsbGxsbGxsbGxsbGxsbGxsJAAAMGxsSAAAAAAAAAAMbGxsbGxsbGxsWDBQbGxsbGxsKBhUbGwEAAAAAAgoTGxsbGxsbGxsbGwMAAAEJEhobGxsbGxsbBwACChUbGxsbGxsbGxsbGxsbAAAAAAAAAAcSGxsbGxsbFRcbGxsbGxsbGxsbGxsbGxsAAAAAAAAAAAAbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGwAAAAAAAAAABRsbGxsbFBAYGxsbGxsbGxsbGxsbGxsbAwAAAAABChUbGxsbGxYAAAACBw4WGxsbGxsbGxsbGxsLAAAFDxsbGxsbGxsbFwEAAAAAAAABDBsbGxsbGxsbGxkNERsbGxsbGwsAEhsbDwAAAAAAAAAFGxsbGxsbGxsbGxsbGxsbGxsQAAAHGxsbCwAAAAAAABAbGxsbGxsbGxsbGxsbGxsbGgEAAAUbGxsbAwAAAAAFGxsbGxsbGxsbGxsbGxsbGxsHAAAABRsbGxsXAQAAARcbGxsbGxsbGxsbGxsbGxsbEgAAAAAJGxsbGxsTAAEVGxsbGxsbGxsbGxsbGxsbGxgBAAAAAAwbGxsbGxsVFxsbGxsbGxsbGxsbGxsbGxsbAwAAAAAADBsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGwkAAAAAAAAMGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsOAAAAAAAAAAwbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGwIAAAAAAAAADBsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbFwgBAAAAAAAMGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsRCgQAAREbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxsbGxv////////////wf///wH///4B8f/+AfD//wHgf/+BwD//wcA//+GAP+PxgH/gP4P/4A/P/+AP///gD4//4B8A/+D/AD/j8YA//+HAP//B4H//weB//4Hw//8B+f//Af///gH///wB///8Af///AH///+B//////////////////w==",
                    "alias" : "Yelp",
                    "description" : "Yelp - Connecting people with great local businesses",
                    "method" : "get",
                    "url" : "http://www.yelp.com/search?ns=1&find_desc={searchTerms}&find_loc={searchLocation}",
                    "suggest" : "http://www.yelp.com/search_suggest?prefix={searchTerms}&loc={searchLocation}"
      });
    });

    SystemBrowserSearchEngines.on("added", this._onAdd.bind(this));
    SystemBrowserSearchEngines.on("changed", this._onChange.bind(this));
    SimpleStorage.on("OverQuota", this._overQuota.bind(this));
    require("unload").ensure(this);
  },

  _onAttach : function _onAttach(worker) {
    worker.on('message', function(data) {
      //console.log(datata);
      this.collect(data);
    }.bind(this));
  },

  // 
  _init : function _init() {
    for each (let systemEngine in SystemBrowserSearchEngines.getVisible()) {
      let engine = SearchEngine("", "", "", "", "", [DEFAULT_TAG], systemEngine);
      this.add(engine);
    }
  },

  // Watch the SystemBrowserSearchEngines for new adds and add them to our system
  // Everything is defaulted to the FOUND_TAG at first
  _onAdd : function _onAdd(systemEngine) {
    let engine = SearchEngine("", "", "", "", "", [FOUND_TAG], systemEngine);
    this.add(engine);
  },

  // Watch the SystemBrowserSearchEngines for changes to engines and update our system
  // Everything is defaulted to the FOUND_TAG at first
  _onChange: function _onChange(systemEngine) {
    let engine = SearchEngine("", "", "", "", "", [FOUND_TAG], systemEngine);
    // just add it again and our system will take care of duplicates while updating the information
    this.add(engine);
  },

  collect : function collect(links) {
    for (var i in links) {
      var link = links[i];
      // site (may) = "http://google.com/search/path/?q="
      var site = URL.URL(link.site);
      // host = "http://google.com/"
      let host = site.replace(site.path, "");
      console.log("host ", host);
      // engine could be a relative URL so use the host path as a base
      let href = URL.URL(link.engine, host);
      console.log("href ", href);
      this.addByURL(href);
    }
  },

  // Add a new engine via the XML url found in pages
  // This checks that the URL actually exists to prevent Firefox from choking on
  // a bad URL.  If the URL does exist then we pass it along to the system service
  // for parsing and then wait for to be added to our new service
  addByURL : function addByURL(url) {
    var request = new xhr.XMLHttpRequest();
    request.open('GET', url, true);
    request.onreadystatechange = function (aEvt) {
      if (request.readyState == 4) {
        if (request.status == 200) {
          if (request.responseXML) {
            // Add the engine
            // ** Note that we can't just try to grab it by name after adding
            // ** it here because there is no ID that's designed to work in that
            // ** way so we add and then wait for the notification from the system
            SystemBrowserSearchEngines.addByURL(url);
          }
        }
      }
    }.bind(this);
    request.send(null);

  },

  add : function add(engine) {
    for (var i in engine.tags) {
      var tag = engine.tags[i];
      this._updateTags(tag, engine);
    }

    // Save this engine to the simple storage according to it's host URL
    SimpleStorage.storage.engines[engine.host] = engine;
    
  },

  _updateTags : function _updateTags(tag, engine) {
      // If the tag doesn't exist yet just create it
      if (!this._engines[tag]) {
        this._engines[tag] = [];
      }

      var found = false;
      for (var e in this._engines[tag]) {
        if (this._engines[tag][e].host == engine.host) {
          found = true;
          this._engines[tag][e] = engine;
          console.log("added", tag, engine.host)
          break;
        }
      }

      if (!found) {
        console.log("pushed", tag, engine.host, this._engines[tag].length);
        this._engines[tag].push(engine);
      }
  },

  // Helper function for adding a tag to an engine and to the cache list of engines
  addTagByHost : function addTagToEngine(tag, host) {
    console.log("addTagByHost", tag, host);
    var engine = SimpleStorage.storage.engines[host];
    engine.appendTag(tag);
    this._updateTags(tag, engine);
  },

  // Helper function for removing a tag from an engine and from the cache list of engines
  removeTagByHost : function removeTagByHost(tag, host) {
    console.log("removeTagByHost", tag, host);
    var engine = SimpleStorage.storage.engines[host];
    console.log("removeTagByHost", engine);
    engine.removeTag(tag);
    for (var e in this._engines[tag]) {
      if (this._engines[tag][e].host == engine.host) {
        this._engines[tag][e] = null;
        delete this._engines[tag][e];
        break;
      }
    }
  },

  remove : function remove(engine) {
    SimpleStorage.storage.engines[engine.host] = null;
    delete SimpleStorage.storage.engines[engine.host];
  },

  get : function get(engine) {
    return SimpleStorage.storage.engines[engine.host] || SimpleStorage.storage.engines[engine];
  },

  getByTag : function(tag) {
    tag = (tag)? tag : DEFAULT_TAG;
    return this._engines[tag];
  },

  getSubmission : function (engine, terms) {
    let location = Geolocation.formatted_address;
    console.log("getSubmission", engine, terms, location);
    return this.get(engine).getSubmission(terms, location);
  },

  _overQuota: function _overQuota() {
    while (SimpleStorage.quotaUsage > 1) {
      SimpleStorage.storage.engines;
    }
  },

  unload : function unload() {
    SystemBrowserSearchEngines.removeListener("added", this._onAdd);
    SystemBrowserSearchEngines.removeListener("changed", this._onChange);
    SimpleStorage.removeListener("OverQuota", this._overQuota);
  }

})();



exports.BrowserSearchEngines = BrowserSearchEngines;
exports.SearchEngine = SearchEngine;
