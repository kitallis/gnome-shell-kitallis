/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

/* JournalDisplay object to show a timeline of the user's past activities
 *
 * This file exports a JournalDisplay object, which carries a JournalDisplay.actor.
 * This is a view of the user's past activities, shown as a timeline, and
 * whose data comes from what is logged in the Zeitgeist service.
 */

/* Style classes used here:
 *
 * journal - The main journal layout
 *     item-spacing - Horizontal space between items in the journal view
 *     row-spacing - Vertical space between rows in the journal view
 *
 * journal-heading - Heading labels for date blocks inside the journal
 *
 * .journal-item .overview-icon - Items in the journal, used to represent files/documents/etc.
 * You can style "icon-size", "font-size", etc. in them; the hierarchy for each item is
 * is StButton -> IconGrid.BaseIcon
 */

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Shell = imports.gi.Shell;
const Lang = imports.lang;
const Signals = imports.signals;
const St = imports.gi.St;
const Mainloop = imports.mainloop;
const Gettext = imports.gettext.domain('gnome-shell');
const _ = Gettext.gettext;
const C_ = Gettext.pgettext;

const FileUtils = imports.misc.fileUtils;
const Calendar = imports.ui.calendar;
const DocInfo = imports.misc.docInfo;
const IconGrid = imports.ui.iconGrid;
const PopupMenu = imports.ui.popupMenu;
const Main = imports.ui.main;
const Zeitgeist = imports.misc.zeitgeist;
const Util = imports.misc.util;


//*** JournalLayout ***
//
// This is a dumb "flow" layout - it doesn't implement behavior on its own; rather,
// it just lays out items as specified by the caller, and leaves all the behavior
// of those items up to the caller itself.
//
// JournalLayout lets you build a layout like this:
//
//    Heading2
//
//    [item]  [item]  [item]
//    [longitem]  [item]  [item]
//
//    Heading2
//
//    [item]  [item]
//
// It does this with just three methods:
//
//   - appendItem (item) - Expects an item.actor - just inserts that actor into the layout.
//
//   - appendHSpace () - Adds a horizontal space after the last item.  The amount of
//     space comes from the "item-spacing" CSS attribute within the "journal" style class.
//
//   - appendNewline () - Adds a newline after the last item, and moves the layout cursor
//     to the leftmost column in the view.  The vertical space between rows comes from
//     the "row-spacing" CSS attribute within the "journal" style class.

function JournalLayout () {
    this._init ();
}

JournalLayout.prototype = {
    _init: function () {
        this._items = []; // array of { type: "item" / "newline" / "hspace", child: item }
        this._container = new Shell.GenericContainer ({ style_class: 'journal' });

        this._container.connect ("style-changed", Lang.bind (this, this._styleChanged));
        this._itemSpacing = 0; // "item-spacing" attribute
        this._rowSpacing = 0;  // "row-spacing" attribute

        // We pack the Shell.GenericContainer inside a box so that it will be scrollable.
        // Shell.GenericContainer doesn't implement the StScrollable interface,
        // but St.BoxLayout does.
        let box = new St.BoxLayout({ vertical: true });
        box.add (this._container, { y_align: St.Align.START, expand: true });

        this.actor = box;

        this._container.connect ("allocate", Lang.bind (this, this._allocate));
        this._container.connect ("get-preferred-width", Lang.bind (this, this._getPreferredWidth));
        this._container.connect ("get-preferred-height", Lang.bind (this, this._getPreferredHeight));
    },

    // We only expect items to have an item.actor field, which is a ClutterActor
    appendItem: function (item) {
        if (!item)
            throw new Error ("item must not be null");

        if (!item.actor)
            throw new Error ("Item must already contain an actor when added to the JournalLayout");

        let i = { type: "item",
                  child: item };

        this._items.push (i);
        this._container.add_actor (item.actor);
    },

    appendNewline: function () {
        let i = { type: "newline" }
        this._items.push (i);
    },

    appendHSpace: function () {
        let i = { type: "hspace" };
        this._items.push (i);
    },

    clear: function () {
        this._items = [];
        this._container.destroy_children ();
    },

    _styleChanged: function () {
        log ("JournalLayout: _styleChanged()");
        let node = this._container.get_theme_node ();

        this._itemSpacing = node.get_length ("item-spacing");
        this._rowSpacing = node.get_length ("row-spacing");

        this._container.queue_relayout ();
    },

    _allocate: function (actor, box, flags) {
        let width = box.x2 - box.x1;
        this._computeLayout (width, true, flags);
    },

    _getPreferredWidth: function (actor, forHeight, alloc) {
        alloc.min_size = 128; // FIXME: get the icon size from CSS
        alloc.natural_size = (48 + this._itemSpacing) * 4 - this._itemSpacing; // four horizontal icons and the spacing between them
    },

    _getPreferredHeight: function (actor, forWidth, alloc) {
        let height = this._computeLayout (forWidth, false, null);

        alloc.min_size = height;
        alloc.natural_size = height;
    },

    // Computes the layout of the items in the journal, based on the available_width.
    //
    // do_allocation is a boolean: if false, only the layout will be computed;
    // if true, the layout will be computed and the items in the journal will
    // be allocated as well by calling their item.allocate() method.  The former
    // is for doing size requisition; the latter is for doing size allocation.
    //
    // Returns: an integer with the resulting height after layout
    _computeLayout: function (available_width, do_allocation, allocate_flags) {
        let layout_state = { newline_goal_column: 0,
                             x: 0,
                             y: 0,
                             row_height : 0,
                             layout_width: available_width };

        let newline = Lang.bind (this, function () {
            layout_state.x = layout_state.newline_goal_column;
            layout_state.y += layout_state.row_height + this._rowSpacing;
            layout_state.row_height = 0;
        });

        for (let i = 0; i < this._items.length; i++) {
            let item = this._items[i];
            let item_layout = { width: 0, height: 0 };

            if (item.type == "item") {
                if (!item.child)
                    throw new Error ("internal error - item.child must not be null");

                item_layout.width = item.child.actor.get_preferred_width (-1)[1]; // [0] is minimum width; [1] is natural width
                item_layout.height = item.child.actor.get_preferred_height (item_layout.width)[1];
            } else if (item.type == "newline") {
                newline ();
                continue;
            } else if (item.type == "hspace") {
                item_layout.width = this._itemSpacing;
            }

            if (layout_state.x + item_layout.width > layout_state.layout_width) {
                newline ();

                if (item.type == "hspace")
                    continue;
            }

            let box = new Clutter.ActorBox ();
            box.x1 = layout_state.x;
            box.y1 = layout_state.y;
            box.x2 = box.x1 + item_layout.width;
            box.y2 = box.y1 + item_layout.height;

            if (item.type == "item" && do_allocation)
                item.child.actor.allocate (box, allocate_flags);

            layout_state.x += item_layout.width;
            if (item_layout.height > layout_state.row_height)
                layout_state.row_height = item_layout.height;
        }

        return layout_state.y + layout_state.row_height;
    }

};


//*** EventItem ***
//
// This is an item that wraps a ZeitgeistItemInfo, which is in turn
// created from an event as returned by the Zeitgeist D-Bus API.

function EventItem (event) {
    this._init (event);
}

EventItem.prototype = {
    _init: function (event) {
        if (!event)
            throw new Error ("event must not be null");

        this._item_info = new DocInfo.ZeitgeistItemInfo (event);
        this._icon = new IconGrid.BaseIcon (this._item_info.name,
                                            { createIcon: Lang.bind (this, function (size) {
                                                  return this._item_info.createIcon (size);
                                              })
                                            });
        this._button = new St.Button ({ style_class: "journal-item",
                                        reactive: true,
                                        button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE, // assume button 2 (middle) does nothing
                                        can_focus: true,
                                        x_fill: true,
                                        y_fill: true });
        this._button.connect ("clicked", Lang.bind (this, this._buttonClicked));
        this.actor = this._button;

        this._button.set_child (this._icon.actor);

        this._menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this);
    },

    _removeMenuTimeout: function() {
        if (this._menuTimeoutId > 0) {
            Mainloop.source_remove(this._menuTimeoutId);
            this._menuTimeoutId = 0;
        }
    },

    // callback for this._button's "clicked" signal
    _buttonClicked: function (actor, button) {
        // FIXME: here we should use double-click for launching immediately with the default application,
        // and single-click with buttons 1 or 3 to bring up a popup menu with actions.  See the TODO
        // list at the bottom of this file for details.
		this._removeMenuTimeout();
		if (button == 1) {
		  this._item_info.launch ();
		} else if (button == 3) {
		  this.popupMenu();
		  return true;
		}
        Main.overview.hide ();
    },

    popupMenu: function() {
        this._removeMenuTimeout();
        this.actor.fake_release();

        if (!this._menu) {
            this._menu = new ActivityIconMenu(this);
            this._menu.connect('activate-window', Lang.bind(this, function (menu, window) {
                this.activateWindow(window);
            }));
            this._menu.connect('popup', Lang.bind(this, function (menu, isPoppedUp) {
                if (!isPoppedUp)
                    this._onMenuPoppedDown();
            }));
            Main.overview.connect('hiding', Lang.bind(this, function () { this._menu.close(); }));

            this._menuManager.addMenu(this._menu);
        }

        this.actor.set_hover(true);
        this.actor.show_tooltip();
        this._menu.popup();

        return false;
    },

    activateWindow: function(metaWindow) {
        if (metaWindow) {
            Main.activateWindow(metaWindow);
        } else {
            Main.overview.hide();
        }
    },

    _onMenuPoppedDown: function() {
        this.actor.sync_hover();
    },

};


//*** ActivityIconMenu ***
//
//
//
function ActivityIconMenu(source) {
    this._init(source);
}

ActivityIconMenu.prototype = {
    __proto__: PopupMenu.PopupMenu.prototype,

    _init: function(source) {
        let side = St.Side.LEFT;
        if (St.Widget.get_default_direction() == St.TextDirection.RTL)
            side = St.Side.RIGHT;

        PopupMenu.PopupMenu.prototype._init.call(this, source.actor, 0.5, side, 0);

        // We want to keep the item hovered while the menu is up
        this.blockSourceEvents = true;

        this._source = source;

        this.connect('activate', Lang.bind(this, this._onActivate));
        this.connect('open-state-changed', Lang.bind(this, this._onOpenStateChanged));

        this.actor.add_style_class_name('app-well-menu');

        // Chain our visibility and lifecycle to that of the source
        source.actor.connect('notify::mapped', Lang.bind(this, function () {
            if (!source.actor.mapped)
                this.close();
        }));
        source.actor.connect('destroy', Lang.bind(this, function () { this.actor.destroy(); }));

        Main.uiGroup.add_actor(this.actor);
    },

    _redisplay: function() {
        this.removeAll();
		this._openItemWith = this._appendMenuItem(_("Open with..."));
        this._showItemInManager = this._appendMenuItem(_("Show in file manager"));
        this._appendSeparator();
        this._removeItemFromJournal = this._appendMenuItem(_("Remove from journal"));
        this._moveFileToTrash = this._appendMenuItem(_("Move to trash"));
	},

    _appendSeparator: function () {
        let separator = new PopupMenu.PopupSeparatorMenuItem();
        this.addMenuItem(separator);
    },

    _appendMenuItem: function(labelText) {
        // FIXME: app-well-menu-item style
        let item = new PopupMenu.PopupMenuItem(labelText);
        this.addMenuItem(item);
        return item;
    },

    popup: function(activatingButton) {
        this._redisplay();
        this.open();
    },

    _onOpenStateChanged: function (menu, open) {
        if (open) {
            this.emit('popup', true);
        } else {
            this.emit('popup', false);
        }
    },

    _onActivate: function (actor, child) {
        if (child._window) {
            let metaWindow = child._window;
            this.emit('activate-window', metaWindow);
        } else if (child == this._openItemWith) {
		} else if (child == this._showItemInManager) {
			Util.spawn(['nautilus', this._source._item_info.subject.origin]);
			Main.overview.hide();
        } else if (child == this._removeItemFromJournal) {
			log("Removing item: " + this._source._item_info.event.id);
			Zeitgeist.deleteEvents([parseInt(this._source._item_info.event.id)]);	
		} else if (child == this._moveFileToTrash) {
			// remove the item from journal after trashing, it'll be recuperated
			// as a new event by the Trash filter
			let uri = this._source._item_info.subject.uri;
			log("Trashing file: " + uri);
			try {
			  let file = Gio.file_new_for_uri(uri);
			  file.trash(null);
			} catch(e) {
			  Util.spawn(['gvfs-trash', uri]);
			}
			Zeitgeist.deleteEvents([parseInt(this._source._item_info.event.id)]);	
		}
        this.close();
    }
};


//*** HeadingItem ***
//
// A simple label for the date block headings in the journal, i.e. the
// labels that display each day's date.

function HeadingItem (label_text) {
    this._init (label_text);
}

HeadingItem.prototype = {
    _init: function (label_text) {
        this._label_text = label_text;
        this.actor = new St.Label ({ text: label_text,
                                     style_class: 'journal-heading' });
    }
};


//*** Utility functions

function _compareEventsByTimestamp (a, b) {
    if (a.timestamp < b.timestamp)
        return -1;
    else if (b.timestamp > a.timestamp)
        return 1;
    else
        return 0;
}


//*** LayoutByTimeBuckets ***
//
// This takes events as delivered by a Zeitgeist query, and lays them out in a
// JournalLayout as a timeline:  newer events first, older events last.
// Events appear grouped by "Today", "Yesterday", "Last Week", etc.

function LayoutByTimeBuckets () {
    this._init ();
}

// A time bucket is a half-open interval [start, end)
function _makeTimeBucket (_name, _start, _end) {
    let bucket = { name: _name,
               start: _start,
               end: _end };
    return bucket;
}

LayoutByTimeBuckets.prototype = {
    _init: function () {
        this.time_buckets = [ ];
        this.layout_done = false;
    },

    _pushTimeBucket: function (name, start, end) {
        if (this.time_buckets.length == 0)
            this.time_buckets.push (_makeTimeBucket (name, start, end));
        else {
            if (end != -1)
                throw new Error ("start timestamp must be -1 when pushing time buckets except for the first one");

            let num_buckets = this.time_buckets.length;

            let oldest_start = this.time_buckets [num_buckets - 1].start;
            if (start >= oldest_start)
                throw new Error ("start timestamp must be earlier than the previously-pushed timestamp");

            this.time_buckets.push (_makeTimeBucket (name, start, oldest_start));
        }
    },

    _setupTimeBuckets: function () {
        let now = new Date();
        let tomorrow = now.getTime () + 86400 * 1000;
        let tomorrow_start = Calendar._getBeginningOfDay (new Date (tomorrow));

        this._pushTimeBucket (_("Future"), tomorrow_start.getTime (), 9999999999999);

        let today_start = Calendar._getBeginningOfDay (now);
        this._pushTimeBucket (_("Today"), today_start.getTime (), -1);

        let yesterday = now.getTime () - 86400 * 1000;
        let yesterday_start = Calendar._getBeginningOfDay (new Date (yesterday));
        this._pushTimeBucket (_("Yesterday"), yesterday_start.getTime (), -1);

        let last_week = now.getTime () - 7 * 86400 * 1000;
        let last_week_start = Calendar._getBeginningOfDay (new Date (last_week));
        this._pushTimeBucket (_("Last week"), last_week_start.getTime (), -1);

        this._pushTimeBucket (_("Older"), 0, -1);
    },

    _findBucketIndexForTimestamp: function (t) {
        for (let i = 0; i < this.time_buckets.length; i++) {
            let b = this.time_buckets[i];

            if (b.start <= t && t < b.end)
                return i;
        }

        return -1;
    },

    // Takes an array of events, straight from a Zeitgeist query callback, and
    // lays them out in the specified JournalLayout.
    layoutEvents: function (events, journal_layout) {
        if (this.layout_done)
            throw new Error ("LayoutByTimeBuckets.layoutEvents() may only be called once; create a new LayoutByTimeBuckets to do a new layout");

        this._setupTimeBuckets ();

        let old_bucket_index = -1;

        for (let i = 0; i < events.length; i++) {
            let e = events[i];
            let t = e.timestamp;

            let bucket_index = this._findBucketIndexForTimestamp (t);
            if (bucket_index == -1)
                throw new Error ("No time bucket was found for timestamp " + t);

            if (old_bucket_index != bucket_index) {
                if (old_bucket_index != -1)
                    journal_layout.appendNewline (); // i.e. only if this is not the *first* heading in the journal

                let heading = new HeadingItem (this.time_buckets[bucket_index].name);

                journal_layout.appendItem (heading);
                journal_layout.appendNewline ();

                old_bucket_index = bucket_index;
            }

            let item = new EventItem (e);
            journal_layout.appendItem (item);
            journal_layout.appendHSpace ();
        }

        this.layout_done = true;
    }
};


//*** LayoutByDays ***
//
// This takes events as delivered by a Zeitgeist query, and lays them out in a
// JournalLayout as a timeline:  newer events first, older events last.
// Events appear grouped by individual days.

function LayoutByDays () {
    this._init ();
}

LayoutByDays.prototype = {
    _init: function () {
    },

    layoutEvents: function (events, journal_layout) {
        let last_timestamp = null;

        for (let i = 0; i < events.length; i++) {
            let e = events[i];
            let d = new Date (e.timestamp);
            let need_date_change = false;

            if (!last_timestamp)
                need_date_change = true;
            else {
                let last_date = new Date (last_timestamp);

                if (!(last_date.getFullYear () == d.getFullYear ()
                      && last_date.getMonth () == d.getMonth ()
                      && last_date.getDate () == d.getDate ()))
                    need_date_change = true;
            }

            if (need_date_change) {
                let label = d.toLocaleFormat (C_("journal heading date", "%a %Y/%b/%d"));
                let heading = new HeadingItem (label);
                log ("heading: " + label);

                if (last_timestamp)
                    journal_layout.appendNewline (); // i.e. only if this is not the *first* heading in the journal

                journal_layout.appendItem (heading);
                journal_layout.appendNewline ();
            }

            last_timestamp = e.timestamp;

            let item = new EventItem (e);
            journal_layout.appendItem (item);
            journal_layout.appendHSpace ();
        }
    }
};


//*** Filter ***
//
// A Filter provides an event template for a Zeitgeist query, a result
// type (e.g. how results are ordered), and a human-readable name for the filter
// so that it can be picked in the journal display.

function Filter (name) {
    this._init (name);
}

Filter.prototype = {
    _init: function (name) {
        this.name = name;
        this.event_template = null;
        this.result_type = Zeitgeist.ResultType.MOST_RECENT_SUBJECTS;
    }
};

function _makeEmptySubject () {
    return new Zeitgeist.Subject ("", "", "", "", "", "", ""); // uri, interpretation, manifestation, origin, mimetype, text, storage
}

function _makeEmptyEventTemplate () {
    let subject = _makeEmptySubject ();
    return new Zeitgeist.Event ("", "", "", [subject], []); // interpretation, manifestation, actor, subjects, payload
}

function EverythingFilter () {
    this._init ();
}

EverythingFilter.prototype = {
    __proto__: Filter.prototype,

    _init: function () {
        Filter.prototype._init.call(this, _("Everything"));
        this.event_template = _makeEmptyEventTemplate ();
    }
};

function NewFilter () {
    this._init ();
}

NewFilter.prototype = {
    __proto__: Filter.prototype,

    _init: function () {
        Filter.prototype._init.call(this, _("Newly-created items"));
        let subject = _makeEmptySubject ();
        this.event_template = new Zeitgeist.Event (
            "http://www.zeitgeist-project.com/ontologies/2010/01/27/zg#CreateEvent", // interpretation
            "", "", [subject], []); // manifestation, actor, subjects, payload
    },
};

function FrequentFilter () {
    this._init ();
}

FrequentFilter.prototype = {
    __proto__: Filter.prototype,

    _init: function() {
        Filter.prototype._init.call(this, _("Frequently-used items"));
        this.event_template = _makeEmptyEventTemplate ();
        this.sorting = Zeitgeist.ResultType.MOST_POPULAR_SUBJECTS;
    },
};

function FavoritesFilter () {
    this._init ();
}

FavoritesFilter.prototype = {
    __proto__: Filter.prototype,

    _init: function () {
        Filter.prototype._init.call(this, _("Favorites"));
        let subject = new Zeitgeist.Subject ("bookmark://", "", "", "", "", "", ""); // uri, interpretation, manifestation, origin, mimetype, text, storage
        this.event_template =  new Zeitgeist.Event("", "", "", [subject], []); // interpretation, manifestation, actor, subjects, payload
    },
};


//*** JournalDisplay ***
//
// This carries a JournalDisplay.actor, for a timeline view of the user's past activities.
//
// Each time the JournalDisplay's actor is mapped, the journal will reload itself
// by querying Zeitgeist for the latest events.  In effect, this means that the user
// gets an updated view every time accesses the journal from the shell.
//
// So far we don't need to install a live monitor on Zeitgeist; the assumption is that
// if you are in the shell's journal, you cannot interact with your apps anyway and
// thus you cannot create any new Zeitgeist events just yet.

function JournalDisplay () {
    this._init ();
}

JournalDisplay.prototype = {
    _init: function () {
        this._box = new St.BoxLayout ({ vertical: false,
                                        style_class: 'all-app' });
	this.actor = this._box;

        this._scroll_view = new St.ScrollView ({ x_fill: true,
                                                 y_fill: true,
					         y_align: St.Align.START,
					         vfade: true });

        this._currentFilter = null;
        this._filter_box = new St.BoxLayout({ vertical: true, reactive: true });

        this._box.add (this._scroll_view, { expand: true, y_fill: true, y_align: St.Align.START });
        this._box.add (this._filter_box, { expand: false, y_fill: false, y_align: St.Align.START });

        this._layout = new JournalLayout ();
        this._scroll_view.add_actor (this._layout.actor);

        this._scroll_view.set_policy (Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
        this._scroll_view.connect ("notify::mapped", Lang.bind (this, this._scrollViewMapCb));

        this._setupFilters ();
    },

    _scrollViewMapCb: function (actor) {
        if (this._scroll_view.mapped)
            this._reload ();
    },

    _selectFilter: function (filter) {
        // Note that filter.button got added in ::_addFilter(); it's not an intrinsic property of the Filter prototype

        for (let i = 0; i < this._filters.length; i++) {
            if (this._filters[i] == filter)
                filter.button.add_style_pseudo_class ("selected");
            else
                this._filters[i].button.remove_style_pseudo_class ("selected");
        }

        this._currentFilter = filter;
        this._reload ();
    },

    _addFilter: function (filter) {
        this._filters.push (filter);
        filter.button = new St.Button ({ label: filter.name,
                                         style_class: 'app-filter',
                                         x_align: St.Align.START,
                                         can_focus: true });
        this._filter_box.add (filter.button, { expand: false, x_fill: false, y_fill: false });

        filter.button.connect ("clicked", Lang.bind (this, function () {
                this._selectFilter (filter);
        }));
    },

    _setupFilters: function () {
        this._filters = [];
        
        let everything = new EverythingFilter ();

        this._addFilter (everything);
        this._addFilter (new NewFilter ());
        this._addFilter (new FrequentFilter ());
        this._addFilter (new FavoritesFilter ());
        
        this._selectFilter (everything);
    },

    _reload : function () {
        this._layout.clear ();

        Zeitgeist.findEvents ([0, 9999999999999],                        // time_range
                              [this._currentFilter.event_template],      // event_templates
                              Zeitgeist.StorageState.ANY,                // storage_state - FIXME: should we use AVAILABLE instead?
                              0,                                         // num_events - 0 for "as many as you can"
                              this._currentFilter.result_type,           // result_type
                              Lang.bind (this, function (events) {
                                             let l = new LayoutByTimeBuckets ();
                                             // let l = new LayoutByDays ();
                                             l.layoutEvents (events, this._layout);
                                         }));
    }

};

// TODO
//
// * Make icons reactive; single-click or right-click to get a Largo-like set of actions; double-click to launch
//     Open with...
//     Show in file manager
//     --------------------
//     Remove from journal
//     Move to trash
//
// * Sort events when we get them (hmm, maybe Zeitgeist already does that for us)
//
// * isearch like in Emacs
//
// * Big Fat Eraser mode, like in gnome-activity-journal
//
