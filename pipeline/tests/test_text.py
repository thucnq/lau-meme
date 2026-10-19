from lau_meme_pipeline.text import fold


def test_ac_health_03_fold_bo_dau():
    """AC-HEALTH-03: khóa so khớp bỏ dấu, chữ thường, gộp khoảng trắng."""
    assert fold("Đơn Nghỉ  Việc") == "don nghi viec"
    assert fold("  ÉT O ÉT ") == "et o et"


def test_ac_health_03_fold_is_idempotent():
    """AC-HEALTH-03: áp hai lần cho cùng kết quả."""
    s = "Còn Cái Nịt"
    assert fold(fold(s)) == fold(s)
