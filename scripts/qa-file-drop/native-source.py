#!/usr/bin/env python3
import sys
from pathlib import Path

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, Gtk

selection = Path(sys.argv[1])
window = Gtk.Window(title="Backspace QA native file source")
window.set_default_size(220, 200)
window.move(12, 40)
button = Gtk.Button(label="Drag local fixture file")
window.add(button)
targets = [Gtk.TargetEntry.new("text/uri-list", 0, 0)]
button.drag_source_set(Gdk.ModifierType.BUTTON1_MASK, targets, Gdk.DragAction.COPY)

def provide_uri(_widget, _context, data, _info, _timestamp):
    file = Path(selection.read_text().strip()).resolve(strict=True)
    print('native drag-data-get ' + file.name, flush=True)
    data.set_uris([file.as_uri()])

button.connect("drag-data-get", provide_uri)
button.connect("drag-begin", lambda *_args: print("native drag-begin", flush=True))
button.connect("drag-end", lambda *_args: print("native drag-end", flush=True))
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
