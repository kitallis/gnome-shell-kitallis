/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

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


/*** TimeView ***/

function TimeView () {
    this._init();
}

TimeView.prototype = {
    _init: function () {
	this._iconGrid = new IconGrid.IconGrid ({ xAlign: St.Align.START });
	this.actor = new St.ScrollView ({ x_fill: true,
					  y_fill: false,
					  y_align: St.Align.START,
					  vfade: true });
	this.actor.add_actor (this._iconGrid.actor);
        this.actor.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.ALWAYS);
    },
};


/*** JournalDisplay ***/

function JournalDisplay () {
    this._init ();
}

JournalDisplay.prototype = {
    _init: function () {
	this._timeView = new TimeView ();
	this.actor = this._timeView.actor;
        
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
