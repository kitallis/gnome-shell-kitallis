/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

// Style classes used here:
//
// journal - The main journal layout

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
        this.actor = new Shell.GenericContainer ({ style_class: 'journal' });
        this.actor.connect ("allocate", Lang.bind (this, this._allocate));

        this._needs_relayout = false;
    },

    appendItem: function (item) {
        if (!item)
            throw new Error ("item must not be null");

        this._items.push (item);
        this._needs_relayout = true;
    },

    _allocate: function (actor, box, flags) {
        let width = box.x2 - box.x1;
        this._computeLayout (width, flags);
    },

    _computeLayout: function (available_width, flags) {
        if (!this._needs_relayout)
            return;

        let layout_state = { newline_goal_column: 0,
                             x: 0,
                             y: 0,
                             row_height : 0,
                             layout_width: available_width };

        let newline = function () {
            layout_state.x = layout_state.newline_goal_column;
            layout_state.y += layout_state.row_height; // FIXME: row spacing?
            layout_state.row_height = 0;
        };

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

            item.allocate (box, flags);

            layout_state.x += item_layout.width; // FIXME: column spacing?
            if (item_layout.height > layout_state.row_height)
                layout_state.row_height = item_layout.height;

            if (item_layout.needs_newline_after) {
                newline ();
            }
        }

        this._needs_relayout = false;
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
        this.actor = null;
    },

    getLayout: function () {
        let min_w, nat_w;
        let min_h, nat_h;

        this._ensureIconActor ();
        
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
    },
    
    _ensureIconActor: function () {
        if (this.actor)
            return;
        
        this.actor = this._item_info.createIcon (48); // FIXME: fetch the icon size from the theme's CSS
    }
};


//*** HeadingItem ***

function HeadingItem (label_text) {
    this._init (label_text);
}

HeadingItem.prototype = {
    _init: function (label_text) {
        this._label_text = label_text;
    },

    getLayout: function () {
        return { width: 0, // FIXME
                 height: 0, // FIXME
                 needs_newline_before: true,
                 needs_newline_after: true };
    },

    setPosition: function (x, y) {
        // FIXME
    }
};


//*** JournalDisplay ***

function JournalDisplay () {
    this._init ();
}

JournalDisplay.prototype = {
    _init: function () {
        this._layout = new JournalLayout ();
	this.actor = new St.ScrollView ({ x_fill: true,
					  y_fill: false,
					  y_align: St.Align.START,
					  vfade: true });
        this.actor.add_actor (this._layout.actor);
        this.actor.set_policy (Gtk.PolicyType.NEVER, Gtk.PolicyType.ALWAYS);

        this._get_events ();
    },

    _get_events: function () {
        let subject = new Zeitgeist.Subject ("file://*", "", "", "", "", "", "")
        let event = new Zeitgeist.Event("", "", "", [subject], []);

        Zeitgeist.findEvents ([0, 9999999999999],                        // time_range
                              [event],                                   // event_templates
                              Zeitgeist.StorageState.ANY,                // storage_state - FIXME: should we use AVAILABLE instead?
                              0,                                         // num_events - 0 for "as many as you can"
                              Zeitgeist.ResultType.MOST_RECENT_SUBJECTS, // result_type
                              Lang.bind (this, function (events) {
                                             log ("got " + events.length + " events");
                                         }));
    },

};
