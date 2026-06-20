"""`load_content_list` must resolve MinerU's relative `img_path`
(`images/<hash>.jpg`) to an absolute path, against the JSON file's directory.

Otherwise the image-enrichment pass (which reads the file to send to Gemini)
can't find it during ingest and silently drops every embedded image.
"""
from __future__ import annotations

import json

from contract_rag.ingest.mineru_runner import _mineru_command, load_content_list


def test_relative_img_path_resolved_to_absolute(tmp_path) -> None:
    method_dir = tmp_path / "txt"
    method_dir.mkdir()
    cl = method_dir / "doc_content_list.json"
    cl.write_text(
        json.dumps(
            [
                {"type": "image", "img_path": "images/abc.jpg", "page_idx": 0},
                {"type": "text", "text": "hi", "page_idx": 0},
            ]
        ),
        encoding="utf-8",
    )

    out = load_content_list(cl)

    assert out[0]["img_path"] == str(method_dir / "images" / "abc.jpg")
    assert out[1] == {"type": "text", "text": "hi", "page_idx": 0}  # untouched


def test_absolute_img_path_left_unchanged(tmp_path) -> None:
    cl = tmp_path / "doc_content_list.json"
    abs_path = "/already/absolute/x.jpg"
    cl.write_text(json.dumps([{"type": "image", "img_path": abs_path}]), encoding="utf-8")
    assert load_content_list(cl)[0]["img_path"] == abs_path


def test_element_without_img_path_untouched(tmp_path) -> None:
    cl = tmp_path / "doc_content_list.json"
    cl.write_text(json.dumps([{"type": "text", "text": "x", "page_idx": 0}]), encoding="utf-8")
    assert load_content_list(cl) == [{"type": "text", "text": "x", "page_idx": 0}]


def test_mineru_command_prefers_current_environment_script(monkeypatch, tmp_path) -> None:
    scripts = tmp_path / "bin"
    scripts.mkdir()
    exe = scripts / "mineru"
    exe.write_text("#!/bin/sh\n", encoding="utf-8")
    monkeypatch.setattr("sysconfig.get_path", lambda name: str(scripts) if name == "scripts" else "")

    assert _mineru_command() == str(exe)
