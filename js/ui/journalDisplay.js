/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

// Style classes used here:
//
// journal - The main journal layout
//     item-spacing - Horizontal space between items in the journal view
//     row-spacing - Vertical space between rows in the journal view
//
// journal-heading - Heading labels for date blocks inside the jorunal

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Shell = imports.gi.Shell;
const Lang = imports.lang;
const Signals = imports.signals;
const St = imports.gi.St;
const Mainloop = imports.mainloop;
const Gettext = imports.gettext.domain('gnome-shell');
const _ = Gettext.gettext;
const C_ = Gettext.pgettext;

const IconGrid = imports.ui.iconGrid;
const Zeitgeist = imports.misc.zeitgeist;
const DocInfo = imports.misc.docInfo;


//*** JournalLayout ***

function JournalLayout () {
    this._init ();
}

JournalLayout.prototype = {
    _init: function () {
        this._items = [];
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

    appendItem: function (item) {
        if (!item)
            throw new Error ("item must not be null");

        if (!item.actor)
            throw new Error ("Item must already contain an actor when added to the JournalLayout");

        this._items.push (item);
        this._container.add_actor (item.actor);
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
            let item_layout = item.getLayout ();

            if (item_layout.needs_newline_before
                || (layout_state.x + item_layout.width > layout_state.layout_width)) {
                newline ();
            }

            let box = new Clutter.ActorBox ();
            box.x1 = layout_state.x;
            box.y1 = layout_state.y;
            box.x2 = box.x1 + item_layout.width;
            box.y2 = box.y1 + item_layout.height;

            if (do_allocation)
                item.allocate (box, allocate_flags);

            layout_state.x += item_layout.width + this._itemSpacing;
            if (item_layout.height > layout_state.row_height)
                layout_state.row_height = item_layout.height;

            if (item_layout.needs_newline_after) {
                newline ();
            }
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
        this.actor = this._item_info.createIcon (128); // FIXME: fetch the icon size from the theme's CSS
        // FIXME: we are generating the icon synchronously.  Do it async.
    },

    getLayout: function () {
        let min_w, nat_w;
        let min_h, nat_h;

        if (this.actor) {
            [min_w, nat_w] = this.actor.get_preferred_width (-1);
            [min_h, nat_h] = this.actor.get_preferred_height (-1);
        } else {
            [min_w, nat_w] = [0, 0];
            [min_h, nat_h] = [0, 0];
        }

        return { width: nat_w,
                 height: nat_h,
                 needs_newline_before: false,
                 needs_newline_after: false };
    },

    allocate: function (box, flags) {
        if (!this.actor)
            return;

        this.actor.allocate (box, flags);
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
    },

    getLayout: function () {
        let [min_w, nat_w] = this.actor.get_preferred_width (-1);
        let [min_h, nat_h] = this.actor.get_preferred_height (-1);
        return { width: nat_w,
                 height: nat_h,
                 needs_newline_before: true,
                 needs_newline_after: true };
    },

    allocate: function (box, flags) {
        this.actor.allocate (box, flags);
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


//*** JournalDisplay ***

function JournalDisplay () {
    this._init ();
}

JournalDisplay.prototype = {
    _init: function () {
        this._scroll_view = new St.ScrollView ({ x_fill: true,
                                                 y_fill: false,
					         y_align: St.Align.START,
					         vfade: true });
	this.actor = this._scroll_view;

        this._layout = new JournalLayout ();
        this._scroll_view.add_actor (this._layout.actor);

        this._scroll_view.set_policy (Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
        this._scroll_view.connect ("notify::mapped", Lang.bind (this, this._scrollViewMapCb));
    },

    _scrollViewMapCb: function (actor) {
        if (this._scroll_view.mapped)
            this._reload ();
    },

    _reload : function () {
        this._layout.clear ();

        let subject = new Zeitgeist.Subject ("file://*", "", "", "", "", "", "");
        let event = new Zeitgeist.Event("", "", "", [subject], []);

        let last_timestamp = null;

        Zeitgeist.findEvents ([0, 9999999999999],                        // time_range
                              [event],                                   // event_templates
                              Zeitgeist.StorageState.ANY,                // storage_state - FIXME: should we use AVAILABLE instead?
                              0,                                         // num_events - 0 for "as many as you can"
                              Zeitgeist.ResultType.MOST_RECENT_SUBJECTS, // result_type
                              Lang.bind (this, function (events) {
                                             log ("got " + events.length + " events");
                                             for (let i = 0; i < events.length; i++) {
                                                 let e = events[i];
                                                 let d = new Date (e.timestamp / 1000);
                                                 let need_date_change = false;

                                                 if (!last_timestamp)
                                                     need_date_change = true;
                                                 else {
                                                     let last_date = new Date (last_timestamp / 1000);

                                                     if (!(last_date.getFullYear () == d.getFullYear ()
                                                           && last_date.getMonth () == d.getMonth ()
                                                           && last_date.getDate () == d.getDate ()))
                                                         need_date_change = true;
                                                 }

                                                 last_timestamp = e.timestamp;

                                                 if (need_date_change) {
                                                     let label = d.toLocaleFormat (C_("journal heading date", "%a %Y/%b/%d"));
                                                     let heading = new HeadingItem (label);
                                                     log ("heading: " + label);
                                                     this._layout.appendItem (heading);
                                                 }

                                                 let item = new EventItem (e);
                                                 log ("  event with timestamp " + d.toDateString() + " " + d.toTimeString ());
                                                 this._layout.appendItem (item);
                                             }
                                         }));


    }

};

// TODO
//
// * Put filenames below icons
//
// * Make icons reactive; single-click or right-click to get a Largo-like set of actions; double-click to launch
//
// * Style up the day headings; they are thin and small and black right now
//
// * Sort events when we get them (hmm, maybe Zeitgeist already does that for us)
//
// * isearch like in Emacs
//
// * Big Fat Eraser mode, like in gnome-activity-journal
//
