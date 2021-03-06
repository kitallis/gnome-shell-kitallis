/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#include "config.h"

#include <string.h>
#include <stdlib.h>

#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <gdk/gdk.h>
#include <gdk/gdkx.h>
#include <meta/display.h>
#include <meta/group.h>
#include <meta/util.h>
#include <meta/window.h>

#define SN_API_NOT_YET_FROZEN 1
#include <libsn/sn.h>

#include "shell-window-tracker-private.h"
#include "shell-app-system.h"
#include "shell-app-private.h"
#include "shell-global.h"
#include "shell-marshal.h"
#include "st.h"

/* This file includes modified code from
 * desktop-data-engine/engine-dbus/hippo-application-monitor.c
 * in the functions collecting application usage data.
 * Written by Owen Taylor, originally licensed under LGPL 2.1.
 * Copyright Red Hat, Inc. 2006-2008
 */

/**
 * SECTION:shell-window-tracker
 * @short_description: Associate windows with applications
 *
 * Maintains a mapping from windows to applications (.desktop file ids).
 * It currently implements this with some heuristics on the WM_CLASS X11
 * property (and some static override regexps); in the future, we want to
 * have it also track through startup-notification.
 */

/* Title patterns to detect apps that don't set WM class as needed.
 * Format: application ID, title regex pattern, NULL (for GRegex) */
static struct
{
  const char *app_id;
  const char *pattern;
  GRegex *regex;
} title_patterns[] =  {
    {"mozilla-firefox.desktop", ".* - Mozilla Firefox", NULL}, \
    {"openoffice.org-writer.desktop", ".* - OpenOffice.org Writer$", NULL}, \
    {"openoffice.org-calc.desktop", ".* - OpenOffice.org Calc$", NULL}, \
    {"openoffice.org-impress.desktop", ".* - OpenOffice.org Impress$", NULL}, \
    {"openoffice.org-draw.desktop", ".* - OpenOffice.org Draw$", NULL}, \
    {"openoffice.org-base.desktop", ".* - OpenOffice.org Base$", NULL}, \
    {"openoffice.org-math.desktop", ".* - OpenOffice.org Math$", NULL}, \
    {NULL, NULL, NULL}
};

struct _ShellWindowTracker
{
  GObject parent;

  ShellApp *focus_app;

  /* <MetaWindow * window, ShellApp *app> */
  GHashTable *window_to_app;

  /* <const char *id, ShellApp *app> */
  GHashTable *running_apps;

  /* <int, ShellApp *app> */
  GHashTable *launched_pid_to_app;
};

G_DEFINE_TYPE (ShellWindowTracker, shell_window_tracker, G_TYPE_OBJECT);

enum {
  PROP_0,
  PROP_FOCUS_APP
};

enum {
  APP_STATE_CHANGED,
  STARTUP_SEQUENCE_CHANGED,
  TRACKED_WINDOWS_CHANGED,

  LAST_SIGNAL
};

static guint signals[LAST_SIGNAL] = { 0 };

static void shell_window_tracker_finalize (GObject *object);
static void set_focus_app (ShellWindowTracker  *tracker,
                           ShellApp            *new_focus_app);
static void on_focus_window_changed (MetaDisplay *display, GParamSpec *spec, ShellWindowTracker *tracker);

static void track_window (ShellWindowTracker *monitor, MetaWindow *window);
static void disassociate_window (ShellWindowTracker *monitor, MetaWindow *window);


static void
shell_window_tracker_get_property (GObject    *gobject,
                            guint       prop_id,
                            GValue     *value,
                            GParamSpec *pspec)
{
  ShellWindowTracker *tracker = SHELL_WINDOW_TRACKER (gobject);

  switch (prop_id)
    {
    case PROP_FOCUS_APP:
      g_value_set_object (value, tracker->focus_app);
      break;
    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (gobject, prop_id, pspec);
      break;
    }
}

static void
shell_window_tracker_class_init (ShellWindowTrackerClass *klass)
{
  GObjectClass *gobject_class = G_OBJECT_CLASS (klass);

  gobject_class->get_property = shell_window_tracker_get_property;
  gobject_class->finalize = shell_window_tracker_finalize;

  g_object_class_install_property (gobject_class,
                                   PROP_FOCUS_APP,
                                   g_param_spec_object ("focus-app",
                                                        "Focus App",
                                                        "Focused application",
                                                        SHELL_TYPE_APP,
                                                        G_PARAM_READABLE));

  signals[APP_STATE_CHANGED] = g_signal_new ("app-state-changed",
                                             SHELL_TYPE_WINDOW_TRACKER,
                                             G_SIGNAL_RUN_LAST,
                                             0,
                                             NULL, NULL,
                                             g_cclosure_marshal_VOID__OBJECT,
                                             G_TYPE_NONE, 1,
                                             SHELL_TYPE_APP);
  signals[STARTUP_SEQUENCE_CHANGED] = g_signal_new ("startup-sequence-changed",
                                   SHELL_TYPE_WINDOW_TRACKER,
                                   G_SIGNAL_RUN_LAST,
                                   0,
                                   NULL, NULL,
                                   g_cclosure_marshal_VOID__BOXED,
                                   G_TYPE_NONE, 1, SHELL_TYPE_STARTUP_SEQUENCE);
  signals[TRACKED_WINDOWS_CHANGED] = g_signal_new ("tracked-windows-changed",
                                                   SHELL_TYPE_WINDOW_TRACKER,
                                                   G_SIGNAL_RUN_LAST,
                                                   0,
                                                   NULL, NULL,
                                                   g_cclosure_marshal_VOID__VOID,
                                                   G_TYPE_NONE, 0);
}

/**
 * get_app_id_from_title:
 *
 * Use a window's "title" property to determine an application ID.
 * This is a temporary crutch for a few applications until we get
 * them correctly setting their WM_CLASS.
 */
static const char *
get_app_id_from_title (MetaWindow   *window)
{
  static gboolean patterns_initialized = FALSE;
  const char *title;
  int i;

  title = meta_window_get_title (window);

  if (!patterns_initialized) /* Generate match patterns once for all */
    {
      patterns_initialized = TRUE;
      for (i = 0; title_patterns[i].app_id; i++)
        {
          title_patterns[i].regex = g_regex_new (title_patterns[i].pattern,
                                                 0, 0, NULL);
        }
    }

  /* Match window title patterns to identifiers for non-standard apps */
  if (title)
    {
      for (i = 0; title_patterns[i].app_id; i++)
        {
          if (g_regex_match (title_patterns[i].regex, title, 0, NULL))
            {
              /* Matched, return the app id we want */
              return title_patterns[i].app_id;
            }
        }
    }
  return NULL;
}

/**
 * get_appid_from_window:
 *
 * Turn the WM_CLASS property into our best guess at a .desktop file id.
 */
static char *
get_appid_from_window (MetaWindow  *window)
{
  const char *wmclass;
  char *appid_guess;

  wmclass = meta_window_get_wm_class (window);
  if (!wmclass)
    return NULL;

  appid_guess = g_ascii_strdown (wmclass, -1);

  /* This handles "Fedora Eclipse", probably others.
   * Note g_strdelimit is modify-in-place. */
  g_strdelimit (appid_guess, " ", '-');

  return appid_guess;
}

/**
 * shell_window_tracker_is_window_interesting:
 *
 * The ShellWindowTracker associates certain kinds of windows with
 * applications; however, others we don't want to
 * appear in places where we want to give a list of windows
 * for an application, such as the alt-tab dialog.
 *
 * An example of a window we don't want to show is the root
 * desktop window.  We skip all override-redirect types, and also
 * exclude other window types like tooltip explicitly, though generally
 * most of these should be override-redirect.
 *
 * Returns: %TRUE iff a window is "interesting"
 */
gboolean
shell_window_tracker_is_window_interesting (MetaWindow *window)
{
  if (meta_window_is_override_redirect (window)
      || meta_window_is_skip_taskbar (window))
    return FALSE;

  switch (meta_window_get_window_type (window))
    {
      /* Definitely ignore these. */
      case META_WINDOW_DESKTOP:
      case META_WINDOW_DOCK:
      case META_WINDOW_SPLASHSCREEN:
      /* Should have already been handled by override_redirect above,
       * but explicitly list here so we get the "unhandled enum"
       * warning if in the future anything is added.*/
      case META_WINDOW_DROPDOWN_MENU:
      case META_WINDOW_POPUP_MENU:
      case META_WINDOW_TOOLTIP:
      case META_WINDOW_NOTIFICATION:
      case META_WINDOW_COMBO:
      case META_WINDOW_DND:
      case META_WINDOW_OVERRIDE_OTHER:
        return FALSE;
      case META_WINDOW_NORMAL:
      case META_WINDOW_DIALOG:
      case META_WINDOW_MODAL_DIALOG:
      case META_WINDOW_MENU:
      case META_WINDOW_TOOLBAR:
      case META_WINDOW_UTILITY:
        break;
    }

  return TRUE;
}

/**
 * get_app_from_window_wmclass:
 *
 * Looks only at the given window, and attempts to determine
 * an application based on WM_CLASS.  If one can't be determined,
 * return %NULL.
 *
 * Return value: (transfer full): A newly-referenced #ShellApp, or %NULL
 */
static ShellApp *
get_app_from_window_wmclass (MetaWindow  *window)
{
  ShellApp *app;
  ShellAppSystem *appsys;
  char *wmclass;
  char *with_desktop;

  appsys = shell_app_system_get_default ();
  wmclass = get_appid_from_window (window);

  if (!wmclass)
    return NULL;

  with_desktop = g_strjoin (NULL, wmclass, ".desktop", NULL);
  g_free (wmclass);

  app = shell_app_system_lookup_heuristic_basename (appsys, with_desktop);
  g_free (with_desktop);

  if (app == NULL)
    {
      const char *id = get_app_id_from_title (window);

      if (id != NULL)
        app = shell_app_system_get_app (appsys, id);
    }

  return app;
}

/**
 * get_app_from_window_group:
 * @monitor: a #ShellWindowTracker
 * @window: a #MetaWindow
 *
 * Check other windows in the group for @window to see if we have
 * an application for one of them.
 *
 * Return value: (transfer full): A newly-referenced #ShellApp, or %NULL
 */
static ShellApp*
get_app_from_window_group (ShellWindowTracker  *monitor,
                           MetaWindow          *window)
{
  ShellApp *result;
  GSList *group_windows;
  MetaGroup *group;
  GSList *iter;

  group = meta_window_get_group (window);
  if (group == NULL)
    return NULL;

  group_windows = meta_group_list_windows (group);

  result = NULL;
  /* Try finding a window in the group of type NORMAL; if we
   * succeed, use that as our source. */
  for (iter = group_windows; iter; iter = iter->next)
    {
      MetaWindow *group_window = iter->data;

      if (meta_window_get_window_type (group_window) != META_WINDOW_NORMAL)
        continue;

      result = g_hash_table_lookup (monitor->window_to_app, group_window);
      if (result)
        break;
    }

  g_slist_free (group_windows);

  if (result)
    g_object_ref (result);

  return result;
}

/**
 * get_app_from_window_pid:
 * @monitor: a #ShellWindowTracker
 * @window: a #MetaWindow
 *
 * Check if the pid associated with @window corresponds to an
 * application we launched.
 *
 * Return value: (transfer full): A newly-referenced #ShellApp, or %NULL
 */
static ShellApp *
get_app_from_window_pid (ShellWindowTracker  *tracker,
                         MetaWindow          *window)
{
  ShellApp *result;
  int pid;

  if (meta_window_is_remote (window))
    return NULL;

  pid = meta_window_get_pid (window);

  if (pid == -1)
    return NULL;

  result = g_hash_table_lookup (tracker->launched_pid_to_app, GINT_TO_POINTER (pid));
  if (result != NULL)
    g_object_ref (result);

  return result;
}

/**
 * get_app_for_window:
 *
 * Determines the application associated with a window, using
 * all available information such as the window's MetaGroup,
 * and what we know about other windows.
 *
 * Returns: (transfer full): a #ShellApp, or NULL if none is found
 */
static ShellApp *
get_app_for_window (ShellWindowTracker    *monitor,
                    MetaWindow         *window)
{
  ShellApp *result;
  const char *startup_id;

  if (meta_window_is_remote (window))
    return shell_app_system_get_app_for_window (shell_app_system_get_default (), window);

  result = NULL;
  /* First, we check whether we already know about this window,
   * if so, just return that.
   */
  if (meta_window_get_window_type (window) == META_WINDOW_NORMAL)
    {
      result = g_hash_table_lookup (monitor->window_to_app, window);
      if (result != NULL)
        {
          g_object_ref (result);
          return result;
        }
    }

  result = get_app_from_window_pid (monitor, window);
  if (result != NULL)
    return result;

  /* Check if the app's WM_CLASS specifies an app */
  result = get_app_from_window_wmclass (window);
  if (result != NULL)
    return result;

  /* Now we check whether we have a match through startup-notification */
  startup_id = meta_window_get_startup_id (window);
  if (startup_id)
    {
      GSList *iter, *sequences;

      sequences = shell_window_tracker_get_startup_sequences (monitor);
      for (iter = sequences; iter; iter = iter->next)
        {
          ShellStartupSequence *sequence = iter->data;
          const char *id = shell_startup_sequence_get_id (sequence);
          if (strcmp (id, startup_id) != 0)
            continue;

          result = shell_startup_sequence_get_app (sequence);
          if (result)
            break;
        }
    }

  /* If we didn't get a startup-notification match, see if we matched
   * any other windows in the group.
   */
  if (result == NULL)
    result = get_app_from_window_group (monitor, window);

  /* Our last resort - we create a fake app from the window */
  if (result == NULL)
    result = shell_app_system_get_app_for_window (shell_app_system_get_default (), window);

  return result;
}

const char *
_shell_window_tracker_get_app_context (ShellWindowTracker *tracker, ShellApp *app)
{
  return "";
}

static void
on_transient_window_title_changed (MetaWindow      *window,
                                   GParamSpec      *spec,
                                   ShellWindowTracker *self)
{
  ShellAppSystem *appsys;
  ShellApp *app;
  const char *id;

  /* Check if we now have a mapping using the window title */
  id = get_app_id_from_title (window);
  if (id == NULL)
    return;

  appsys = shell_app_system_get_default ();
  app = shell_app_system_get_app (appsys, id);
  if (app == NULL)
    return;
  g_object_unref (app);

  /* We found an app, don't listen for further title changes */
  g_signal_handlers_disconnect_by_func (window, G_CALLBACK (on_transient_window_title_changed),
                                        self);

  /* It's simplest to just treat this as a remove + add. */
  disassociate_window (self, window);
  track_window (self, window);
}

static void
track_window (ShellWindowTracker *self,
              MetaWindow      *window)
{
  ShellApp *app;

  if (!shell_window_tracker_is_window_interesting (window))
    return;

  app = get_app_for_window (self, window);
  if (!app)
    return;

  /* At this point we've stored the association from window -> application */
  g_hash_table_insert (self->window_to_app, window, app);

  if (shell_app_is_transient (app))
    {
      /* For a transient application, it's possible one of our title regexps
       * will match at a later time, i.e. the application may not have set
       * its title fully at the time it initially maps a window.  Watch
       * for title changes and recompute the app.
       */
      g_signal_connect (window, "notify::title", G_CALLBACK (on_transient_window_title_changed), self);
    }

  _shell_app_add_window (app, window);

  g_signal_emit (self, signals[TRACKED_WINDOWS_CHANGED], 0);
}

static void
shell_window_tracker_on_window_added (MetaWorkspace   *workspace,
                                   MetaWindow      *window,
                                   gpointer         user_data)
{
  ShellWindowTracker *self = SHELL_WINDOW_TRACKER (user_data);

  track_window (self, window);
}

static void
disassociate_window (ShellWindowTracker   *self,
                     MetaWindow        *window)
{
  ShellApp *app;

  app = g_hash_table_lookup (self->window_to_app, window);
  if (!app)
    return;

  g_object_ref (app);

  g_hash_table_remove (self->window_to_app, window);

  if (shell_window_tracker_is_window_interesting (window))
      _shell_app_remove_window (app, window);

  g_signal_emit (self, signals[TRACKED_WINDOWS_CHANGED], 0);

  g_object_unref (app);
}

static void
shell_window_tracker_on_window_removed (MetaWorkspace   *workspace,
                                     MetaWindow      *window,
                                     gpointer         user_data)
{
  disassociate_window (SHELL_WINDOW_TRACKER (user_data), window);
}

static void
load_initial_windows (ShellWindowTracker *monitor)
{
  GList *workspaces, *iter;
  MetaScreen *screen = shell_global_get_screen (shell_global_get ());
  workspaces = meta_screen_get_workspaces (screen);

  for (iter = workspaces; iter; iter = iter->next)
    {
      MetaWorkspace *workspace = iter->data;
      GList *windows = meta_workspace_list_windows (workspace);
      GList *window_iter;

      for (window_iter = windows; window_iter; window_iter = window_iter->next)
        {
          MetaWindow *window = window_iter->data;
          track_window (monitor, window);
        }

      g_list_free (windows);
    }
}

static void
shell_window_tracker_on_n_workspaces_changed (MetaScreen    *screen,
                                           GParamSpec    *pspec,
                                           gpointer       user_data)
{
  ShellWindowTracker *self = SHELL_WINDOW_TRACKER (user_data);
  GList *workspaces, *iter;

  workspaces = meta_screen_get_workspaces (screen);

  for (iter = workspaces; iter; iter = iter->next)
    {
      MetaWorkspace *workspace = iter->data;

      /* This pair of disconnect/connect is idempotent if we were
       * already connected, while ensuring we get connected for
       * new workspaces.
       */
      g_signal_handlers_disconnect_by_func (workspace,
                                            shell_window_tracker_on_window_added,
                                            self);
      g_signal_handlers_disconnect_by_func (workspace,
                                            shell_window_tracker_on_window_removed,
                                            self);

      g_signal_connect (workspace, "window-added",
                        G_CALLBACK (shell_window_tracker_on_window_added), self);
      g_signal_connect (workspace, "window-removed",
                        G_CALLBACK (shell_window_tracker_on_window_removed), self);
    }
}

static void
init_window_tracking (ShellWindowTracker *self)
{
  MetaDisplay *display;
  MetaScreen *screen = shell_global_get_screen (shell_global_get ());

  g_signal_connect (screen, "notify::n-workspaces",
                    G_CALLBACK (shell_window_tracker_on_n_workspaces_changed), self);
  display = meta_screen_get_display (screen);
  g_signal_connect (display, "notify::focus-window",
                    G_CALLBACK (on_focus_window_changed), self);

  shell_window_tracker_on_n_workspaces_changed (screen, NULL, self);
}

void
_shell_window_tracker_notify_app_state_changed (ShellWindowTracker *self,
                                                ShellApp           *app)
{
  ShellAppState state = shell_app_get_state (app);

  switch (state)
    {
    case SHELL_APP_STATE_RUNNING:
      /* key is owned by the app */
      g_hash_table_insert (self->running_apps, (char*)shell_app_get_id (app), app);
      break;
    case SHELL_APP_STATE_STARTING:
      break;
    case SHELL_APP_STATE_STOPPED:
      g_hash_table_remove (self->running_apps, shell_app_get_id (app));
      break;
    }
  g_signal_emit (self, signals[APP_STATE_CHANGED], 0, app);
}

static void
on_startup_sequence_changed (MetaScreen            *screen,
                             SnStartupSequence     *sequence,
                             ShellWindowTracker    *self)
{
  ShellApp *app;

  app = shell_startup_sequence_get_app ((ShellStartupSequence*)sequence);
  if (app)
    _shell_app_handle_startup_sequence (app, sequence);

  g_signal_emit (G_OBJECT (self), signals[STARTUP_SEQUENCE_CHANGED], 0, sequence);
}

static void
shell_window_tracker_init (ShellWindowTracker *self)
{
  MetaScreen *screen;

  self->window_to_app = g_hash_table_new_full (g_direct_hash, g_direct_equal,
                                               NULL, (GDestroyNotify) g_object_unref);

  self->running_apps = g_hash_table_new (g_str_hash, g_str_equal);

  self->launched_pid_to_app = g_hash_table_new_full (NULL, NULL, NULL, (GDestroyNotify) g_object_unref);

  screen = shell_global_get_screen (shell_global_get ());

  g_signal_connect (G_OBJECT (screen), "startup-sequence-changed",
                    G_CALLBACK (on_startup_sequence_changed), self);

  load_initial_windows (self);
  init_window_tracking (self);
}

static void
shell_window_tracker_finalize (GObject *object)
{
  ShellWindowTracker *self = SHELL_WINDOW_TRACKER (object);
  int i;

  g_hash_table_destroy (self->running_apps);
  g_hash_table_destroy (self->window_to_app);
  g_hash_table_destroy (self->launched_pid_to_app);

  for (i = 0; title_patterns[i].app_id; i++)
    g_regex_unref (title_patterns[i].regex);

  G_OBJECT_CLASS (shell_window_tracker_parent_class)->finalize(object);
}

/**
 * shell_window_tracker_get_window_app:
 * @monitor: An app monitor instance
 * @metawin: A #MetaWindow
 *
 * Returns: (transfer full): Application associated with window
 */
ShellApp *
shell_window_tracker_get_window_app (ShellWindowTracker *monitor,
                                  MetaWindow      *metawin)
{
  MetaWindow *transient_for;
  ShellApp *app;

  transient_for = meta_window_get_transient_for (metawin);
  if (transient_for != NULL)
    metawin = transient_for;

  app = g_hash_table_lookup (monitor->window_to_app, metawin);
  if (app)
    g_object_ref (app);

  return app;
}


/**
 * shell_window_tracker_get_app_from_pid:
 * @self; A #ShellAppSystem
 * @pid: A Unix process identifier
 *
 * Look up the application corresponding to a process.
 *
 * Returns: (transfer none): A #ShellApp, or %NULL if none
 */
ShellApp *
shell_window_tracker_get_app_from_pid (ShellWindowTracker *self, 
                                       int                 pid)
{
  GSList *running = shell_window_tracker_get_running_apps (self, "");
  GSList *iter;
  ShellApp *result = NULL;

  for (iter = running; iter; iter = iter->next)
    {
      ShellApp *app = iter->data;
      GSList *pids = shell_app_get_pids (app);
      GSList *pids_iter;

      for (pids_iter = pids; pids_iter; pids_iter = pids_iter->next)
        {
          int app_pid = GPOINTER_TO_INT (pids_iter->data);
          if (app_pid == pid)
            {
              result = app;
              break;
            }
        }
      g_slist_free (pids);

      if (result != NULL)
        break;
    }

  g_slist_free (running);

  return result;
}

/**
 * shell_window_tracker_get_running_apps:
 * @monitor: An app monitor instance
 * @context: Activity identifier
 *
 * Returns the set of applications which currently have at least one open
 * window in the given context.  The returned list will be sorted
 * by shell_app_compare().
 *
 * Returns: (element-type ShellApp) (transfer full): Active applications
 */
GSList *
shell_window_tracker_get_running_apps (ShellWindowTracker *monitor,
                                    const char      *context)
{
  gpointer key, value;
  GSList *ret;
  GHashTableIter iter;

  g_hash_table_iter_init (&iter, monitor->running_apps);

  ret = NULL;
  while (g_hash_table_iter_next (&iter, &key, &value))
    {
      ShellApp *app = value;

      if (strcmp (context, _shell_window_tracker_get_app_context (monitor, app)) != 0)
        continue;

      ret = g_slist_prepend (ret, g_object_ref (app));
    }

  ret = g_slist_sort (ret, (GCompareFunc)shell_app_compare);

  return ret;
}

static void
on_child_exited (GPid      pid,
                 gint      status,
                 gpointer  unused_data)
{
  ShellWindowTracker *tracker;

  tracker = shell_window_tracker_get_default ();

  g_hash_table_remove (tracker->launched_pid_to_app, GINT_TO_POINTER((gint)pid));
}

void
_shell_window_tracker_add_child_process_app (ShellWindowTracker *tracker,
                                             GPid                pid,
                                             ShellApp           *app)
{
  gpointer pid_ptr = GINT_TO_POINTER((int)pid);

  if (g_hash_table_lookup (tracker->launched_pid_to_app,
                           &pid_ptr))
    return;

  g_hash_table_insert (tracker->launched_pid_to_app,
                       pid_ptr,
                       g_object_ref (app));
  g_child_watch_add (pid, on_child_exited, NULL);
  /* TODO: rescan unassociated windows
   * Unlikely in practice that the launched app gets ahead of us
   * enough to map an X window before we get scheduled after the fork(),
   * but adding this note for future reference.
   */
}

static void
set_focus_app (ShellWindowTracker  *tracker,
               ShellApp            *new_focus_app)
{
  if (new_focus_app == tracker->focus_app)
    return;

  if (tracker->focus_app != NULL)
    g_object_unref (tracker->focus_app);

  tracker->focus_app = new_focus_app;

  if (tracker->focus_app != NULL)
    g_object_ref (tracker->focus_app);

  g_object_notify (G_OBJECT (tracker), "focus-app");
}

static void
on_focus_window_changed (MetaDisplay        *display,
                         GParamSpec         *spec,
                         ShellWindowTracker *tracker)
{
  MetaWindow *new_focus_win;
  ShellApp *new_focus_app;

  new_focus_win = meta_display_get_focus_window (display);
  new_focus_app = new_focus_win ? shell_window_tracker_get_window_app (tracker, new_focus_win) : NULL;

  set_focus_app (tracker, new_focus_app);
}

/**
 * shell_window_tracker_get_startup_sequences:
 * @self:
 *
 * Returns: (transfer none) (element-type ShellStartupSequence): Currently active startup sequences
 */
GSList *
shell_window_tracker_get_startup_sequences (ShellWindowTracker *self)
{
  ShellGlobal *global = shell_global_get ();
  MetaScreen *screen = shell_global_get_screen (global);
  return meta_screen_get_startup_sequences (screen);
}

/* sn_startup_sequence_ref returns void, so make a
 * wrapper which returns self */
static SnStartupSequence *
sequence_ref (SnStartupSequence *sequence)
{
  sn_startup_sequence_ref (sequence);
  return sequence;
}

GType
shell_startup_sequence_get_type (void)
{
  static GType gtype = G_TYPE_INVALID;
  if (gtype == G_TYPE_INVALID)
    {
      gtype = g_boxed_type_register_static ("ShellStartupSequence",
          (GBoxedCopyFunc)sequence_ref,
          (GBoxedFreeFunc)sn_startup_sequence_unref);
    }
  return gtype;
}

const char *
shell_startup_sequence_get_id (ShellStartupSequence *sequence)
{
  return sn_startup_sequence_get_id ((SnStartupSequence*)sequence);
}

/**
 * shell_startup_sequence_get_app:
 * @sequence: A #ShellStartupSequence
 *
 * Returns: (transfer full): The application being launched, or %NULL if unknown.
 */
ShellApp *
shell_startup_sequence_get_app (ShellStartupSequence *sequence)
{
#ifdef HAVE_SN_STARTUP_SEQUENCE_GET_APPLICATION_ID
  const char *appid;
  ShellAppSystem *appsys;
  ShellApp *app;

  appid = sn_startup_sequence_get_application_id ((SnStartupSequence*)sequence);
  if (!appid)
    return NULL;

  appsys = shell_app_system_get_default ();
  app = shell_app_system_get_app_for_path (appsys, appid);
  return app;
#else
  return NULL;
#endif
}

const char *
shell_startup_sequence_get_name (ShellStartupSequence *sequence)
{
  return sn_startup_sequence_get_name ((SnStartupSequence*)sequence);
}

gboolean
shell_startup_sequence_get_completed (ShellStartupSequence *sequence)
{
  return sn_startup_sequence_get_completed ((SnStartupSequence*)sequence);
}

/**
 * shell_startup_sequence_create_icon:
 * @sequence:
 * @size: Size in pixels of icon
 *
 * Returns: (transfer none): A new #ClutterTexture containing an icon for the sequence
 */
ClutterActor *
shell_startup_sequence_create_icon (ShellStartupSequence *sequence, guint size)
{
  GIcon *themed;
  const char *icon_name;
  ClutterActor *texture;

  icon_name = sn_startup_sequence_get_icon_name ((SnStartupSequence*)sequence);
  if (!icon_name)
    {
      texture = clutter_texture_new ();
      clutter_actor_set_size (texture, size, size);
      return texture;
    }

  themed = g_themed_icon_new (icon_name);
  texture = st_texture_cache_load_gicon (st_texture_cache_get_default (),
                                         NULL, themed, size);
  g_object_unref (G_OBJECT (themed));
  return texture;
}


/**
 * shell_window_tracker_get_default:
 *
 * Return Value: (transfer none): The global #ShellWindowTracker instance
 */
ShellWindowTracker *
shell_window_tracker_get_default ()
{
  static ShellWindowTracker *instance;

  if (instance == NULL)
    instance = g_object_new (SHELL_TYPE_WINDOW_TRACKER, NULL);

  return instance;
}
