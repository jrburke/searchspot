const data = require("self").data,
      winUtils = require("window-utils"),
      tabs = require("tabs"),
      xhr = require("xhr"),
      timers = require("timers"),

      {Cc, Ci} = require("chrome"),

      WM = Cc['@mozilla.org/appshell/window-mediator;1'].
        getService(Ci.nsIWindowMediator),

      { BrowserSearchEngines } = require("browser-search-engine"),

      SEARCH_TEXTBOX = "searchbar",
      STYLESHEET_ID = "searchspot-style";

const ffwm = new ffWindowManager();

function getSearchTextBox() {
  return winUtils.activeBrowserWindow.document.getElementById(SEARCH_TEXTBOX);
}

BrowserSearchEngines.on("removed", function(engine) {
  SearchSpotPanel.port.emit("removeEngine", engine);
});

BrowserSearchEngines.on("added", function(engine) {
  SearchSpotPanel.port.emit("addEngine", engine);
});

var SearchSpotPanel = require("autocomplete-panel").Panel({
  contentURL: data.url("searchspot-results.html"),
  contentScriptFile : [data.url("jquery.1.6.4.js"),
                       data.url("results.js")],
  onShow : function() {
    SearchSpotPanel.port.emit("setEngines", BrowserSearchEngines.getByTag())
    SearchSpotPanel.port.emit("setTerms", gCurrentQuery);
  }
});

SearchSpotPanel.port.on("preferences", function(sizes) {
  require("tabs").open({
    url: data.url("preferences.html"),
    onReady: function onOpen(tab) {
      var worker = tab.attach({
          contentScriptFile : [data.url("jquery.1.6.4.js"),
                               data.url("jquery-ui-1.8.17.custom.min.js"),
                               data.url("preferences.js")],
          onMessage: function (data) {
            
          }
      });
      worker.port.on("addTag", function(tag, host) {
        console.log("worker.port.on.addTag", tag, host);
        BrowserSearchEngines.addTagByHost(tag, host);
      });
      worker.port.on("removeTag", function(tag, host) {
        console.log("worker.port.on.removeTag", tag, host);
        BrowserSearchEngines.removeTagByHost(tag, host);
      });
      var tags = BrowserSearchEngines.tags;
      console.log("tags", tags);
      for (var i in tags) {
        var tag = tags[i];
        var engines = BrowserSearchEngines.getByTag(tag);
        console.log("tag", tag, engines);
        worker.port.emit("add", tag, engines);
      }
    }
  });
  // Finally hide the search panel as a new search has begun
  SearchSpotPanel.hide();
});

SearchSpotPanel.port.on("resize", function(sizes) {
  var textbox = 300;
  try {
    getSearchTextBox().clientWidth;
  } catch (ignore) { }
  SearchSpotPanel.resize(Math.max(sizes.width, textbox, 300), Math.max(sizes.height,50));
});

SearchSpotPanel.port.on("click", function(data) {
  let url = BrowserSearchEngines.getSubmission(data.engine, data.terms);

  // Here we track the adventure of the search tab!
  // If the term "foodie" is still in the search area when the tab is closed
  // we clear out the search area assuming they are done searching for "foodie"
  tabs.activeTab.once('close', function(tab) {
    var terms = data.terms;
    // will trigger on shutdown but we'll start losing window objects so just ignore errors
    try {
      if (getSearchTextBox().value == terms) {
        getSearchTextBox().value = "";
      }
    } catch (ignore) {}
  });

  // Set the URL to start the search
  tabs.activeTab.url = url;

  // Set the search box with the actual terms used
  // i.e. (suggestions may be different than terms in input area)
  try {
    getSearchTextBox().value = data.terms;
  } catch(ignore) { }

  // Finally hide the search panel as a new search has begun
  SearchSpotPanel.hide();
});

var PermissionPanel = require("permission-panel").Panel({
  contentURL: data.url("permission.html"),
  contentScriptFile : [data.url("jquery.1.6.4.js"),
                       data.url("permission.js")]
});

PermissionPanel.port.on("click", function(data) {
  if (data == "ok") {
    BrowserSearchEngines.geolocation = true;
    getSearchTextBox().focus();
  } else {
    console.log("permission denied, please uninstall");
  }
  PermissionPanel.hide();
});

PermissionPanel.port.on("resize", function(sizes) {
  var textbox = 300;
  try {
    getSearchTextBox().clientWidth;
  } catch (ignore) { }
  PermissionPanel.resize(Math.max(sizes.width, textbox, 300), Math.max(sizes.height,50));
});

/**
 * Window watcher object (will attach to all windows, even pref windows)
 * Attaches buttons to new windows and removes them when they disappear
 */
function ffWindowManager() {
  return {
    onTrack: function ffWindowManager_onTrack(window) {
      if (winUtils.isBrowser(window)) {
        addStylesheet(window.document);
        attachToSearch(window.document);
      }
    },
    onUntrack: function ffWindowManager_onUntrack(window) {
      if (winUtils.isBrowser(window)) {
        removeStylesheet(window.document);
        detachFromSearch(window.document);
      }
    }
  }
}

exports.main = function (options, callbacks) {
  var windowTracker = new winUtils.WindowTracker(ffwm);
  require("unload").ensure(windowTracker);
};


/// SEARCH INPUT

var gCurrentQuery;
var gCurrentTimer;

function attachToSearch(document) {
  var textbox = document.getElementById(SEARCH_TEXTBOX);
  if (textbox) {
    // Invasion of the search input snatchers!  Clone the search input field
    var searchbox = textbox.cloneNode(false);
    // Insert clone into position
    textbox.parentNode.insertBefore(searchbox, textbox.nextSibling);
    // While the humans aren't looking lets hide the old field and change it's id
    // Now all existing search commands should come to our clone field
    textbox.setAttribute("hidden", "true");
    textbox.setAttribute("id", SEARCH_TEXTBOX + "_old");

    // Disable the normal autocomplete features
    searchbox.setAttribute("disableautocomplete", "true");
    searchbox.removeAttribute("type");
    // Prevent the default search command handler from doing anything, we handle that below
    searchbox.handleSearchCommand = function(e) { }

    var openpanel = function(e) {
      if (searchbox.value == "") {
        return;
      }
      if (!SearchSpotPanel.isShowing) {
        if (BrowserSearchEngines.geolocation) {
          SearchSpotPanel.show(searchbox);
        } else {
          PermissionPanel.show(searchbox);
        }
      } else {
        // Set the terms before we allow them to hit enter
        SearchSpotPanel.port.emit("setTerms",searchbox.value);

        // down arrow
        if (e.keyCode == 40) {
          SearchSpotPanel.port.emit("next");
          e.preventDefault();
          return;
        // up arrow
        } else if (e.keyCode == 38) {
          SearchSpotPanel.port.emit("previous");
          e.preventDefault();
          return;
        // enter
        } else if (e.keyCode == 13) {
          e.preventDefault();
          e.stopPropagation();
          SearchSpotPanel.port.emit("go");
          return;
        }
      }

      // don't refresh if the string hasn't changed!
      if (searchbox.value == gCurrentQuery) { return; }
      gCurrentQuery = searchbox.value;

      try {
        function refreshSuggestions()
        {

          for each (let engine in BrowserSearchEngines.getByTag()) {
            //dump("name: " + engine.name + "\n");

            function runRequest(terms, name, url) {
              var baseurl = "", type = "suggest";
              //console.log("runRequest", name);

              // XXX HACKS!!
              if (name == "http://en.wikipedia.org/") {
                baseurl = "http://en.wikipedia.org/wiki/";
                type = "match";
              }

              if (url == null) {
                return;
              }

              var request = new xhr.XMLHttpRequest();
              request.open('GET', url, true);
              request.onreadystatechange = function (aEvt) {
                if (request.readyState == 4) {
                  if (request.status == 200) {
                    // Our request returned but it's too late and the terms have changed
                    if (gCurrentQuery != terms) {
                      return;
                    }
                    // ["term", ["suggestions", "of", "matches" ]]
                    // ex: ["json",["jsonline","json","json validator","jsonp"]]
                    try {
                      if (name == "http://www.yelp.com/") {
                        // Yelp returns a crappy HTML answer instead of JSON
                        // We just send the whole body object to the iframe to let the DOM parse it all
                        // {"body": "<ul>\n\t\t\t
                        //            <li title=\"Elysian Coffee\">Elysian<span class=\"highlight\">&nbsp;Coffee</span></li>\n\t\t\t
                        //            <li title=\"Elysian Room\">Elysian<span class=\"highlight\">&nbsp;Room</span></li>\n\t
                        //           </ul>",
                        // "unique_request_id": "a1fdaa421112b2b5"}
                        var response = JSON.parse(request.responseText)["body"];
                        SearchSpotPanel.port.emit("yelp",{ "terms" : terms, "name" : name, "results" : response, "type" : type });
                        return;
                      }
                    var results = [];
                    var suggestions = JSON.parse(request.responseText)[1];
                    suggestions.forEach(function(item) {
                      if (results.length >= 3) {
                        return;
                      }
                      if (terms != item) {
                        results.push({ "title" : item, "url" : (type == "match")? baseurl + item : "" });
                      }
                    });
                    SearchSpotPanel.port.emit("add",{ "name" : name, "results" : results, "type" : type, "terms" : terms });
                    } catch (error) { dump("suggest error: " + error + "\n" + url + "\n"); }
                  }
                  else {
                    dump('Request Error ' + request.status + " : " + request.statusText + "\n" + url + "\n");
                  }
                }
              };
              request.send(null);
            }

            let suggestionURL = engine.getSuggestion(searchbox.value);
            if (suggestionURL) {
              runRequest(searchbox.value, engine.host, suggestionURL);
            }
          }
        }

        if (gCurrentTimer) {
          timers.clearTimeout(gCurrentTimer);
        }
        gCurrentTimer = timers.setTimeout(refreshSuggestions, 300);

      }catch(err) { dump("err: " + err + "\n"); }

      return;

    };

    searchbox.onfocus = openpanel;
    searchbox.onclick = openpanel;
    searchbox.onkeyup = openpanel;

  } else {
    console.error("attachToSearch: couldn't find " + SEARCH_TEXTBOX)
  }
}

function detachFromSearch(document) {
  var searchbox = document.getElementById(SEARCH_TEXTBOX);
  var textbox = document.getElementById(SEARCH_TEXTBOX + "_old");
  if (textbox && searchbox) {
    // Remove our search box from the browser
    var parent = searchbox.parentNode;
    parent.removeChild(searchbox);
    // Reset the old search entry to it's former glory
    textbox.removeAttribute("hidden");
    textbox.setAttribute("id", SEARCH_TEXTBOX);
  } else {
    console.error("detachFromSearch: couldn't find " + SEARCH_TEXTBOX)
  }
}

/// STYLE SHEETS

function addStylesheet(document) {
  var uri = data.url(STYLESHEET_ID + ".css");
  var pi = document.createProcessingInstruction(
    "xml-stylesheet", "href=\"" + uri + "\" type=\"text/css\"");
  document.insertBefore(pi, document.firstChild);
}

function removeStylesheet(document) {
  var css = "href=\"" + data.url(STYLESHEET_ID + ".css") + "\" type=\"text/css\"";
  var found = false;
  for (var top = document.firstChild; top.target == "xml-stylesheet"; top = top.nextSibling) {
    if (top.data == css) {
      var parent = top.parentNode;
      parent.removeChild(top);
      found = true;
      break;
    }
  }
  if (!found) {
    console.error("removeStylesheet: couldn't find the " + STYLESHEET_ID);
  }
}
